# Proposal

## Why

The repo holds two separately-named servers with their own config loaders, shutdown handlers and
a duplicated `list_servers`, and it still describes an abandoned "knowledge pack" direction. The
source server's profile loader also accepts path segments in a server name, so `x/../.env.prod`
loads a profile under a false name, and it merges every `.env` it finds, so one box's file can
inherit another's password. Before any guard can be trusted, the kit needs one identity, one
validated profile loader and one server process.

## What Changes

- **Hard fork:** the two engines become kit packages `@ibmi-agent-kit/screen` and
  `@ibmi-agent-kit/source`; the upstream-sync rule is dropped. Original LICENSE/NOTICE text stays;
  each file changed from upstream gets a modification line.
- New `@ibmi-agent-kit/core` package with the single profile loader used by both engines.
- New `@ibmi-agent-kit/server` package: one stdio MCP server (`bin: ibmi-agent-kit`) mounting both
  engines' tools. Engines expose `register(mcp)` and install no process handlers; the server owns
  logging redirection, error hooks and one shutdown that signs off 5250 sessions and closes SQL
  connections before exiting.
- **BREAKING (config):** profiles load from `IBMI_KIT_CONFIG_DIR`, else `~/.ibmi-agent-kit`, with
  `~/.ibm-i-servers` still read as a fallback. A server name must exactly match a profile listed
  by `list_servers`; the first file found wins whole, with no merging across files.
- Each engine's own `bin` keeps working, renamed `ibmi-agent-kit-screen` and
  `ibmi-agent-kit-source`.
- Root `npm run check` builds and checks packages in dependency order.
- README, CLAUDE.md and `docs/idea.md` rewritten for the execute-and-guard direction; the
  superseded `knowledge-pack-v1` change is removed.

### MCP tools added or changed

| Tool | Annotation | Change |
|---|---|---|
| `list_servers` | read-only | served once by the kit, from the core loader |
| every screen and source tool | unchanged | same inputs and outputs; the `server` argument is now validated by the core loader |

## Out of scope

- The execution guard (change `execution-guard`) and project verbs (change `project-verbs`).
- Credential storage in the OS keychain; profiles stay as files in this change.
- Publishing to npm.
- Any change to 5250 protocol handling, SQL transport or compile behaviour.

## Capabilities

### New Capabilities
- `server-profiles`: how named IBM i server profiles are found, validated and loaded.
- `unified-server`: one MCP server process mounting every engine's tools, with one lifecycle.

### Modified Capabilities
- None (no specs exist yet).

## Impact

- `packages/screen`, `packages/source`: package names, `bin` names, `src/index.ts` split into
  `tools.ts` (registration) and `index.ts` (standalone bootstrap); `src/config.ts` delegates
  file lookup to core.
- New `packages/core`, `packages/server`.
- Root `package.json`, `README.md`, `CLAUDE.md`, `NOTICE`, `docs/idea.md`, `.gitignore`.
- Users with profiles in `~/.ibm-i-5250-mcp` or `~/.ibm-i-source-mcp` must move them to
  `~/.ibmi-agent-kit` (the shared `~/.ibm-i-servers` keeps working).
