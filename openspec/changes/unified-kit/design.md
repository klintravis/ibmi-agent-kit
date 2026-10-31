# Design

## Context

- Each engine's `src/index.ts` creates a module-level `McpServer`, registers tools at import,
  redirects `console.log`, installs `unhandledRejection`/`uncaughtException` and SIGINT/SIGTERM
  handlers that call `process.exit`, and calls `main()`. Importing either starts a server.
- Screen `config.ts` validates names (`SERVER_NAME`) and loads only the first `.env`; source
  `config.ts` does neither and calls dotenv on every folder's `.env`. Folder lists differ.
- Each engine has one `loadProfile(env)` that parses an env map into its own `Profile` shape.
- No `exports` map in either `package.json`; source has no `main`.

## Goals / Non-Goals

**Goals:** one loader, one process lifecycle, engines mountable without side effects, both
engines' own checks still green.

**Non-Goals:** changing engine `Profile` shapes or tool behaviour; keychain credentials.

## Decisions

### D1. `core` resolves a name to an env map; engines keep their parsers
`@ibmi-agent-kit/core` exports `listServers()`, `resolveProfileEnv(name?)` (exact-match check
against `listServers()`, then reads that one file with `dotenv.parse`, overlays process env for
keys the file omits except host/user/password) and `CONFIG_DIRS`. Each engine's
`loadProfileFor(server)` becomes `loadProfile(resolveProfileEnv(server))`.
- *Why:* the engines' `Profile` shapes differ (5250 geometry vs SSH port, CCSID handling); keeping
  their parsers means no behaviour change, and the security fix lands in one place.
- *Alternative — one merged Profile type in core:* couples the engines for no user benefit now.

### D2. Split `index.ts` into `tools.ts` + bootstrap
`tools.ts` exports `register(mcp): { shutdown(): Promise<void> }` containing today's tool
definitions verbatim, minus process hooks. `index.ts` keeps the standalone bootstrap: create
server, `register`, install hooks, connect stdio. The kit server calls both `register`s and owns
the hooks.
- *Alternative — kit spawns engines as child processes:* three processes and no shared lifecycle.

### D3. `list_servers` registered by the server, not the engines
`register(mcp, { listServers: false })` skips the engine's own `list_servers`; the server
registers one backed by core. Duplicate detection relies on the SDK, which already throws
`Tool <name> is already registered`; the server catches it at startup and exits with that
message.

### D4. Shutdown with one budget
Server shutdown runs both engines' `shutdown()` in parallel under one 5-second `Promise.race`,
then exits. Screen's existing sign-off logic moves into its `shutdown()` unchanged.

### D5. Package layout and build order
`packages/core`, `packages/screen`, `packages/source`, `packages/server`. Root `check` runs
`npm run check -w packages/core -w packages/screen -w packages/source -w packages/server` in that
order (npm runs `-w` in the order given). The server imports `@ibmi-agent-kit/screen/dist/tools.js`;
each engine gets an `exports` map with `.` → `dist/index.js` and `./tools` → `dist/tools.js`.

### D6. Modification notices
Every upstream file changed gets, after any shebang, one line:
`// Modified by ibmi-agent-kit (2026): <what changed>.` Upstream `LICENSE`/`NOTICE` files stay
in each package; package `author` becomes the kit owner with `contributors` crediting Saman.

## Risks / Trade-offs

- [Old profile folders `~/.ibm-i-5250-mcp` / `~/.ibm-i-source-mcp` stop being read] → documented
  in README migration notes; the shared `~/.ibm-i-servers` still works.
- [Moving tool code into `tools.ts` produces a large diff] → it is a move; the engines'
  self-checks prove behaviour is unchanged.
- [SDK duplicate-tool error message changes between versions] → selfcheck asserts startup fails
  on a duplicate, not the exact text.

## Migration Plan

Users registered against `ibm-i-5250-mcp` / `ibm-i-source-mcp` re-register with
`ibmi-agent-kit` and move profiles to `~/.ibmi-agent-kit` (or keep `~/.ibm-i-servers`).
