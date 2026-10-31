# Tasks

## 1. Core: profiles and transport interface (server-profiles, sql-transport specs; D1, D2)

- [x] 1.1 Create `packages/core` (`@ibmi-agent-kit/core`, declarations on, `check` = build + `node --test dist/selfcheck.js`) exporting `CONFIG_DIRS`, `listServers()`, `resolveProfileEnv(name?)` and the `SqlTransport` type; verify `npm run check -w packages/core` runs
- [x] 1.2 Selfcheck with temp folders and a saved/restored `process.env` for every server-profiles scenario: folder order incl. `IBMI_MCP_CONFIG_DIR`, `.env.example` ignored, old per-engine folder ignored, traversal refused without reading, case mismatch refused, omitted server, no merge, `.env` does not leak into `.env.prod`, protected keys never from env, viewer key from env, `process.env` unchanged after loading; verify all pass

## 2. Source engine on the transport (sql-transport spec; D2)

- [ ] 2.1 Refactor `MapepireBackend` onto `SqlTransport` with `ssh` (existing SSH/jar path) and `daemon` (`DaemonServer`) implementations selected by `IBMI_SQL_TRANSPORT` / `IBMI_MAPEPIRE_PORT`; add public `execute(sql, params)` and `cl(command)`; add modification notices; verify `npm run check -w packages/source` passes every pre-existing check
- [ ] 2.2 Selfcheck with a stub transport: daemon profile makes no SSH connection, unknown transport fails naming the allowed values, `execute` passes bound values with the statement text unchanged, `cl` failure returns message ids and text; verify all pass

## 3. Engines become mountable kit packages (unified-server spec; D3, D4, D6, D8)

- [ ] 3.1 Rename screen to `@ibmi-agent-kit/screen` (bin `ibmi-agent-kit-screen`, `exports` with `./tools`, `declaration: true`, author/contributors), split `index.ts` into `tools.ts` + bootstrap, switch `config.ts` to `resolveProfileEnv` and delete its module-level `loadEnv`, add annotations and titles to every tool, add modification notices; verify `npm run check -w packages/screen` passes every pre-existing check
- [ ] 3.2 Same for source as `@ibmi-agent-kit/source` (bin `ibmi-agent-kit-source`); verify `npm run check -w packages/source` passes every pre-existing check
- [ ] 3.3 Per engine, selfcheck that importing `./tools.js` adds no process listeners (SIGINT, SIGTERM, uncaughtException, unhandledRejection), writes nothing to stdout, and leaves `process.env` unchanged; verify both pass

## 4. Kit server (unified-server spec; D5, D6)

- [ ] 4.1 Create `packages/server` (`@ibmi-agent-kit/server`, bin `ibmi-agent-kit`) importing `@ibmi-agent-kit/screen/tools` and `@ibmi-agent-kit/source/tools`, mounting both with `listServers: false`, registering one `list_servers` (profiles plus open sessions), owning console redirection, error hooks and shutdown on SIGINT/SIGTERM/stdin end/transport close; verify `npm run check -w packages/server` runs
- [ ] 4.2 Selfcheck over an in-memory MCP client: the five named tools present, `list_servers` exactly once, annotations as specified for the named tools, forced duplicate aborts startup naming the tool, shutdown with stub engines resolves within 5 s when one never settles; verify all pass
- [ ] 4.3 Selfcheck that spawns `node packages/server/dist/index.js`, sends `initialize` + `tools/list`, parses every stdout line as JSON-RPC, then closes stdin and asserts the child exits within 6 s with its stub shutdown called; verify it passes on this Windows host

## 5. Repo reset, CI and docs (D4, D7, D9)

- [ ] 5.1 Root `package.json`: `check` in dependency order and a cross-platform `clean`; verify `npm run clean && npm run check` passes in PowerShell and in Git Bash
- [ ] 5.2 Add `.github/workflows/check.yml` (3 OS × Node 18/22, read-only permissions); verify it is valid YAML and, after push, all six jobs pass
- [ ] 5.3 Add `scripts/check-names.mjs` (D9); verify it reports "skipped" without a list and exits 1 when a temp list contains a word present in the tree
- [ ] 5.4 Rewrite `README.md` (what the kit is; install and `claude mcp add` registration; profiles, folders and protected settings; SQL transports and what each requires on the IBM i; PUB400 notes incl. `IBMI_SSH_PORT=2222`; migration from the old servers; terminology: "commands and statements" vs custom "verbs"; Built on), `CLAUDE.md`, `docs/idea.md` (execute-and-guard direction; roadmap unified-kit → execution-guard → project-verbs → company pilot), `NOTICE` (hard-fork wording), and remove `packs/private/` from `.gitignore`; verify each shell command in README parses (`--help` runs) and `scripts/check-names.mjs` reports no hits

## Workflow follow-up

- Archive with `/opsx:archive` after review, syncing specs into `openspec/specs/`.
