# Design

## Context

- Both engines are stdio MCP servers whose `src/index.ts` creates a module-level `McpServer`,
  registers tools at import time (screen with `mcp.tool`, source with `mcp.registerTool`) and
  calls `main()` unconditionally. Importing either one today starts a server.
- Each engine loads its server profile in exactly one place: screen in `openSession`
  (`loadProfileFor(opts.server)`), source in `getBackend` (`loadProfileFor(server)`). Both read the
  same profile files (`IBMI_MCP_CONFIG_DIR`, `~/.ibm-i-servers`, …), so profiles are already
  unified.
- Guards already exist and are profile fields: screen `restricted`, `allowedCl`, `blockedCl`;
  source `readOnly`, `blockedCl`, `blockedTables`, and `assertSelectOnly` on `run_sql`.
- The screen engine's `testrun.ts` already exports `parseTest`, `parseAction` and `applyActions`.
- Source `runSql` does not take parameters, but its private `fetchRows` already passes
  `parameters` to Mapepire.
- Both engines are subtrees of upstream repos; every edit to them makes upstream pulls harder.

## Goals / Non-Goals

**Goals:**
- Mount both engines in one process with the smallest possible edits to their files.
- Packs validated strictly at startup; a bad pack never takes the server down.
- One place where pack safety is merged into a profile, so "tighten only" is enforceable.

**Non-Goals:**
- Changing any engine tool's input or output shape.
- A pack registry, remote loading, or hot reload. Restart the server to reload packs.

## Decisions

### D1. Split each engine's `index.ts` into `tools.ts` + a thin `index.ts`
`tools.ts` exports `register(mcp, hooks?)`; `index.ts` becomes create server → `register` →
connect stdio. `hooks.tightenProfile(profile, serverName)` is called right after the single
`loadProfileFor` call in each engine. The screen `register` also returns a small handle
(`getSession(name)`) so the kit can run workflows on a session the agent opened.
- *Why:* a move plus about ten new lines per engine; standalone `bin` behaviour is identical.
- *Alternative — kit spawns both engines as child processes and proxies MCP:* zero engine edits,
  but three processes, doubled latency, and no way to reach a session for `workflow_run`.
- *Alternative — reimplement tool registration in the kit:* duplicates ~600 lines of upstream
  tool descriptions that would drift.

### D2. `list_servers` deduplication via a skip list
`register` accepts `hooks.skipTools`; the kit passes `["list_servers"]` to the source engine and
keeps the screen engine's. The kit then wraps `mcp.tool`/`mcp.registerTool` to fail startup on
any other duplicate name.

### D3. Pack format: YAML validated by zod `.strict()`, Markdown workflows
- `yaml` (eemeli/yaml) parses files; `zod` (already a dependency of both engines) validates them.
  `.strict()` makes unknown keys errors, which is what catches typos.
- Layout: `pack.yaml` (name, version, description, optional `safety`), `schema/*.yaml`,
  `glossary/*.yaml`, `queries/*.yaml`, `workflows/*.md`. One file may hold many entries, so a team
  can split by subject area.
- Workflow front matter is a fenced ```` ```inputs ```` YAML block, not `---` front matter, because
  the screen parser ignores everything outside `5250-*` fences — the file stays valid for
  `run_tests` unchanged.
- *Alternative — JSON:* no comments, worse for the people writing packs.
- *Alternative — one big pack file:* merge conflicts when several people edit a pack.

### D4. Query tools reuse the source engine's backend
- Source `runSql(statement, maxRows, reporter, parameters?)` gains the optional last argument,
  passed through to the existing `fetchRows`. `assertSelectOnly` still runs first.
- The kit obtains the backend through a handle returned by source `register` (`getBackend`), so
  query tools share the engine's connection cache, timeout and reset behaviour.
- Parameter types map to zod schemas for the tool input; `?` markers are counted at load time
  (outside string literals) against the declared parameters.

### D5. Safety merge is a pure function over a profile
`tightenProfile(profile, server)` returns a copy: union of `blockedCl` and `blockedTables` from
every loaded pack; `readOnly = profile.readOnly || anyPackRequiresReadOnly(server)`. The pack
safety schema simply has no keys for `allowedCl`, `restricted` or unblocking, and `.strict()`
turns any such key into a load error. Packs therefore cannot express loosening at all.

### D6. Credential-looking keys are rejected by a recursive key scan
Before zod validation, every key in every pack YAML is checked against
`/pass(word)?|secret|token|api[_-]?key/i`; the error names the file and key, never the value.

### D7. Modified upstream files carry a notice
Each edited engine file gets one header line: `Modified by ibmi-agent-kit: <what>`, satisfying
Apache-2.0 §4(b) and making the delta obvious on the next `git subtree pull`.

## Risks / Trade-offs

- [Upstream restructures `index.ts`] → the split is a move, so a conflicting pull is resolved by
  re-applying D1; kept small on purpose. `npm run check` must stay green in both engines.
- [Deep imports into engine `dist/` break if upstream adds an `exports` map] → import via the
  workspace package name and add `exports` entries in the engine `package.json` if needed.
- [Generated query tools inflate the tool list for big packs] → `pack_describe` stays the
  discovery path; a later change may add an opt-out per query. Noted, not solved in v1.
- [Workflow input substitution limited to `type` values] → deliberate: inputs cannot become key
  names or field refs, so a caller cannot steer a workflow onto other keys.
- [A pack's meaning is wrong] → packs are code-reviewed text; the kit validates shape and
  references, not truth.

## Migration Plan

Additive. Existing users of either engine keep running its own `bin` with no change. Adopters
switch their MCP registration to the kit's `bin` and set `IBMI_KIT_PACKS`. Rollback is
registering the engine `bin`s again.

## Open Questions

- Whether PUB400 permits automated sessions at the rate a workflow suite generates; the sample
  pack's workflows should be short until that is known.
