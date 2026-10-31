# Design

## Context

- Each engine's `src/index.ts` creates a module-level `McpServer`, registers tools at import,
  redirects `console.log`, installs `unhandledRejection`/`uncaughtException` and SIGINT/SIGTERM
  handlers that call `process.exit`, and calls `main()`. Importing either starts a server.
- Screen `config.ts` validates names and loads only the first `.env` into `process.env`; source
  `config.ts` validates nothing and loads every folder's `.env` into `process.env`. Folder lists
  differ. Both parse profiles with their own `loadProfile(env)`.
- Source SQL goes through `MapepireBackend`; its only public SQL call is `runSql` (select-only via
  `assertSelectOnly`). `sql`, `fetchRows` and `clResult` are private. The SSH transport
  (`sshMapepire.ts`) uploads `vendor/mapepire-server.jar` and runs it in PASE.
- `@ibm/mapepire-js` (installed) exports `DaemonServer {host, port}` for an already-running
  Mapepire server.
- Both tsconfigs set `declaration: false`. No `exports` map in either `package.json`.
- The SDK's stdio server transport does not shut down when stdin ends; on Windows a parent that
  ends the child does not deliver SIGTERM.
- No tool sets `annotations` today.

## Goals / Non-Goals

**Goals:** one loader with no environment side effects; one process lifecycle that also ends
cleanly on Windows; a transport that can execute; engines mountable without side effects; all
existing checks green.

**Non-Goals:** changing engine `Profile` shapes or tool outputs; JDBC; keychain credentials.

## Decisions

### D1. Core resolves a name to an env map; engines keep their parsers
`@ibmi-agent-kit/core` exports `CONFIG_DIRS`, `listServers()` and `resolveProfileEnv(name?)`:
exact-match check against `listServers()`, read that one file with `dotenv.parse` (never
`dotenv.config`), then overlay process-env values only for keys outside the protected set
(`IBMI_HOST`, `IBMI_USER`, `IBMI_PASSWORD`, `IBMI_*_PORT`, `IBMI_SQL_TRANSPORT`,
`IBMI_RESTRICTED`, `IBMI_ALLOWED_CL`, `IBMI_BLOCKED_CL`, `IBMI_BLOCKED_TABLES`, `IBMI_READ_ONLY`,
`IBMI_5250_TLS_INSECURE`). Each engine's `loadProfileFor(server)` becomes
`loadProfile(resolveProfileEnv(server))`, and its module-level `loadEnv` calls are deleted.
- *Why:* the engines' `Profile` shapes differ; keeping their parsers means no behaviour change and
  the fix lands in one place.

### D2. Transport interface in core, Mapepire implementations in source
```ts
interface SqlTransport {
  query(sql: string, params?: unknown[], maxRows?: number): Promise<{ rows; columns; truncated }>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; messages: Msg[] }>;
  cl(command: string): Promise<{ ok: boolean; messages: Msg[] }>;
  close(): Promise<void>;
}
```
`MapepireBackend` is refactored to sit on a `SqlTransport`; its existing private helpers move
behind it unchanged. `ssh` wraps today's `sshMapepire.ts`; `daemon` uses `DaemonServer`. `cl`
uses `QSYS2.QCMDEXC` and returns the job messages the backend already collects. `runSql` keeps
`assertSelectOnly`; `execute` and `cl` have no check of their own — the guard (next change) is
their gate, and until then only internal code calls them.
- *Alternative — leave transport inside source:* the server could not run `run_script` without
  reaching into source's private methods.

### D3. Split `index.ts` into `tools.ts` + bootstrap
`tools.ts` exports `register(mcp, opts): { shutdown(): Promise<void>, backend(server) }` with
today's tool definitions verbatim, minus process hooks; `opts.listServers: false` skips the
engine's own `list_servers`. `index.ts` keeps the standalone bootstrap.

### D4. Package layout, exports and types
`packages/core`, `packages/screen`, `packages/source`, `packages/server`. Each engine gets
`"exports": { ".": "./dist/index.js", "./tools": "./dist/tools.js" }` with matching `types`, and
`declaration: true`. The server imports `@ibmi-agent-kit/screen/tools`. Root `check` runs
`npm run check -w packages/core -w packages/screen -w packages/source -w packages/server` (npm runs
`-w` in the given order). A root `clean` script uses `node -e "fs.rmSync(...)"` so it works in
PowerShell and POSIX shells.

### D5. Shutdown on signals or stdin end
The server's shutdown runs on SIGINT, SIGTERM, `process.stdin` `end`, and `transport.onclose`,
once, running both engines' `shutdown()` in parallel under one 5-second `Promise.race`, then exits.

### D6. `list_servers` and annotations
The server registers one `list_servers` backed by core that appends, per profile, the screen
engine's open sessions (from `register`'s handle). Every tool registration gains `annotations`
and `title`; the read-only set is `list_servers`, `screen_snapshot`, `run_sql`,
`read_source_member`, `search_source`, `list_libraries`, `list_source_files`, `list_members`.

### D7. CI
`.github/workflows/check.yml`: matrix `os: [windows-latest, macos-latest, ubuntu-latest]` ×
`node: [18, 22]`, `npm ci && npm run check`, `permissions: contents: read`.

### D8. Modification notices
Every upstream file changed gets, after any shebang, `// Modified by ibmi-agent-kit (2026): <what>.`
Package `author` becomes the kit owner with `contributors` crediting Saman.

### D9. Private-name check
`scripts/check-names.mjs` greps the tracked tree for each line of
`~/.ibmi-agent-kit/private-names.txt` (a file only the owner holds, never committed); prints
"skipped: no list" when the file is absent, and exits non-zero on any hit. Run before pushing.

## Risks / Trade-offs

- [Moving tool code into `tools.ts` is a large diff] → a move; engine self-checks prove behaviour.
- [Daemon transport untested against a real daemon here] → unit-tested with a stub; PUB400 does
  not run a public daemon, so live verification waits for a box that has one.
- [Users relying on env-provided safety flags lose them] → declared BREAKING with migration notes.

## Migration Plan

Re-register with `ibmi-agent-kit`; move profiles to `~/.ibmi-agent-kit` (or keep
`~/.ibm-i-servers`); move any `IBMI_*` connection or safety values from the MCP registration's
environment into the profile file.
