# Proposal

## Why

The two engines already know IBM i in general, but every enterprise's IBM i is different: its
libraries, its file and field names, what `CMCRLM` means, which menu path releases a credit
hold. Today the only way to teach an agent that is to write code, so each adopter forks and
diverges. A universal, text-only pack format lets any team teach the kit their system by writing
YAML and Markdown, and gives an existing SQL-based MCP (such as a PowerShell/JDBC one) a direct
porting path: its queries become pack entries instead of a rewrite.

## What Changes

- New **knowledge pack** format: a folder with `pack.yaml` plus optional `schema/`,
  `glossary/`, `queries/`, `workflows/` and `safety` sections. Plain text, reviewable, no code.
- New **unified MCP entry point** (`packages/kit`) that serves the screen tools, the source
  tools and the pack tools from one stdio server, so an adopter registers one server, not three.
- **Declarative query tools**: each entry in a pack's `queries/` becomes its own MCP tool with
  typed parameters, bound as SQL parameters (never string-spliced), executed read-only through
  the source engine's existing Mapepire connection.
- **Workflows reuse the screen engine's Markdown test format** (`5250-do` / `5250-expect`), so a
  workflow is both something an agent can run and a test.
- Pack **safety** settings may only tighten the server profile's guards (restricted mode, blocked
  CL, blocked tables, read-only), never loosen them.
- A **sample pack** for PUB400 with invented business meaning, as the worked example.
- Small, additive changes to the imported packages: each `index.ts` gains an exported
  `register…Tools(mcp)` so the kit can mount it; `runSql` gains optional bound parameters.
  Standalone behaviour of both packages is unchanged.

### MCP tools added or changed

| Tool | Annotation |
|---|---|
| `pack_list` — loaded packs, their versions and what each contributes | read-only |
| `pack_describe` — schema, glossary terms, queries and workflows of a pack, filterable | read-only |
| `pack_lookup` — resolve a business term or field to objects and meaning | read-only |
| `<pack>_<query>` — one tool per declared query | read-only |
| `workflow_run` — run a pack workflow on an open 5250 session | destructive (drives a real session; bounded by the profile's guards) |
| `list_servers` — now served once by the kit instead of once per engine | read-only, unchanged behaviour |

All existing screen and source tools are mounted unchanged.

## Out of scope

- Write queries (`insert`/`update`/`delete`/`call`) in packs. Queries are select-only in v1.
- Drafting a pack from the system catalog (`pack init`) — a later change.
- Workflow discovery and promotion, session recording, `explore`/`test` modes beyond what the
  engines already enforce.
- Renaming or republishing the imported packages to npm.
- Loading packs from a git URL; v1 loads from local folders only.
- Any real enterprise's data. The sample pack uses PUB400 objects with invented meaning.

## Capabilities

### New Capabilities
- `knowledge-packs`: the pack format, how packs are found and loaded, validation, and the
  read-only tools that expose a pack's schema and glossary to an agent.
- `pack-queries`: declared SQL queries exposed as typed, read-only MCP tools.
- `pack-workflows`: named screen workflows in a pack, run on a 5250 session or as tests.
- `unified-server`: one MCP entry point mounting the screen, source and pack tools, with the
  rule that packs can only tighten safety.

### Modified Capabilities
- None. No specs exist yet in `openspec/specs/`.

## Impact

- New package `packages/kit` (TypeScript, Node ≥ 18, depends on `packages/screen`,
  `packages/source`, the MCP SDK, `zod`, and a YAML parser).
- `packages/screen/src/index.ts`, `packages/source/src/index.ts`: split tool registration from
  bootstrap (additive; their own `bin` still works). `packages/source/src/mapepire.ts`:
  optional `parameters` on `runSql`. These are edits to imported Apache-2.0 files, so each
  carries a modification notice.
- New `packs/pub400-sample/`. `packs/private/` stays gitignored for real enterprise packs.
- README gains a "Write a pack" section.
