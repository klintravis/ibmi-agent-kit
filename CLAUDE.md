# ibmi-agent-kit

One MCP server for IBM i (5250 screens, source members, SQL and CL). Intent and roadmap:
`docs/idea.md`. Setup: `README.md`.

## Layout

- `packages/core`: profile loader (`CONFIG_DIRS`, `resolveProfileEnv`) and the SQL transport type
- `packages/guard`: execution guard, pure: statement classifier (`classify`) and the CL command table
  (`src/commands.yaml`)
- `packages/screen`: 5250 engine, `register(mcp)` in `src/tools.ts`
- `packages/source`: source and SQL engine, `register(mcp)` in `src/tools.ts`
- `packages/server`: the kit's stdio server; owns `list_servers`, logging and shutdown
- `scripts/check-names.mjs`: public-repo name check

## Rules

- Every change starts as an OpenSpec change (`/opsx:propose`); rules are in `openspec/config.yaml`.
- Public repo: no company names, hostnames, library names or credentials. Examples use PUB400 or
  invented names. Run `node scripts/check-names.mjs` before pushing.
- `packages/screen` and `packages/source` are a hard fork of SH4RKKK's Apache-2.0 servers. Keep
  their `LICENSE` and `NOTICE`, and put a `// Modified by ibmi-agent-kit (2026): ...` line on
  every file changed from upstream.
- Engines install no process handlers and write nothing to stdout; the server owns both.
- Connection and safety settings come from the profile file only, never the environment.
- Knowledge of a company's system belongs in Claude skills, not in this MCP.

## Check

`npm run clean && npm run check` builds in dependency order and runs each package's
`src/selfcheck.ts` with `node --test`. No live IBM i is needed.
