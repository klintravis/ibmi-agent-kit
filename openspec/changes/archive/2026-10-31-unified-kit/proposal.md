# Proposal

## Why

The repo holds two separately-named servers with their own config loaders, shutdown handlers and
a duplicated `list_servers`, and still describes an abandoned "knowledge pack" direction. The
source server's profile loader accepts path segments in a server name (`x/../.env.prod` loads a
profile under a false name), and both servers load `.env` files into the process environment, so
one box's settings can leak into another's profile. SQL reaches the IBM i only one way — SSH plus
uploading a Java jar — which many shops will not allow, and the only public SQL call is
select-only, so nothing can run a script. Before any guard can be trusted, the kit needs one
identity, one validated profile loader, one process lifecycle and a SQL path that can execute.

## What Changes

- **Hard fork:** the engines become `@ibmi-agent-kit/screen` and `@ibmi-agent-kit/source`; the
  upstream-sync rule is dropped. Original LICENSE/NOTICE text stays; each file changed from
  upstream gets a modification line.
- New `@ibmi-agent-kit/core`: the single profile loader and the **SQL transport** interface.
- **Pluggable SQL transport** with two implementations: `ssh` (today's behaviour: SSH plus the
  bundled jar) and `daemon` (an admin-installed Mapepire server, no SSH and no upload). Selected per
  profile with `IBMI_SQL_TRANSPORT`. The transport offers query, execute (with bound parameters,
  returning rows affected and messages) and CL command execution, so later changes can run scripts.
  A JDBC transport can be added later behind the same interface.
- New `@ibmi-agent-kit/server`: one stdio MCP server (`bin: ibmi-agent-kit`) mounting both engines.
  Engines expose `register(mcp)` and install no process handlers; the server owns logging
  redirection, error hooks and one shutdown, triggered by signals **or** the client closing stdin,
  that signs off 5250 sessions and closes SQL connections.
- **BREAKING (config):**
  - Profiles load from `IBMI_KIT_CONFIG_DIR` (or the old `IBMI_MCP_CONFIG_DIR`), else
    `~/.ibmi-agent-kit`, else `~/.ibm-i-servers`. The per-engine folders and the install folder
    are no longer read.
  - A server name must exactly match a listed profile. One file supplies a whole profile.
    Nothing from any `.env` file is loaded into the process environment.
  - Connection and safety settings never come from the environment.
- Every tool declares MCP annotations (read-only, destructive, idempotent, open-world).
- Each engine's own `bin` keeps working, renamed `ibmi-agent-kit-screen` / `ibmi-agent-kit-source`.
- Root `npm run check` builds and checks packages in dependency order; a GitHub Actions workflow
  runs it on Windows, macOS and Linux with Node 18 and 22.
- README, CLAUDE.md and `docs/idea.md` rewritten for the execute-and-guard direction; leftover
  knowledge-pack lines removed from `.gitignore`.

### MCP tools added or changed

| Tool | Annotation | Change |
|---|---|---|
| `list_servers` | read-only | served once by the kit from the core loader; also lists open 5250 sessions per server, as the screen engine's did |
| every screen and source tool | per tool | same inputs and outputs; `server` validated by the core loader; annotations added |

## Out of scope

- The execution guard (`execution-guard`) and verbs (`project-verbs`).
- A JDBC transport and OS keychain credentials (the interface allows both later).
- Publishing to npm. Any change to 5250 protocol handling or compile behaviour.

## Capabilities

### New Capabilities
- `server-profiles`: how named IBM i server profiles are found, validated and loaded.
- `sql-transport`: how SQL and CL reach the IBM i, and what callers can rely on.
- `unified-server`: one MCP server process mounting every engine's tools, with one lifecycle.

### Modified Capabilities
- None (no specs exist yet).

## Impact

- `packages/screen`, `packages/source`: package names and `bin`s; `src/index.ts` split into
  `tools.ts` and a bootstrap; `src/config.ts` delegates to core; source `MapepireBackend` uses the
  core transport; tsconfigs emit declarations; tools gain annotations.
- New `packages/core`, `packages/server`, `.github/workflows/check.yml`.
- Root `package.json`, `README.md`, `CLAUDE.md`, `NOTICE`, `docs/idea.md`, `.gitignore`.
- Users with profiles in `~/.ibm-i-5250-mcp`, `~/.ibm-i-source-mcp` or an install folder must move
  them; users relying on `IBMI_*` connection or safety settings from their MCP registration's
  environment must put them in the profile file.
