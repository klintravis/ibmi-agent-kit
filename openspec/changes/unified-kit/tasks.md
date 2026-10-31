# Tasks

## 1. Core profile loader (server-profiles spec, design D1)

- [ ] 1.1 Create `packages/core` (`@ibmi-agent-kit/core`, TypeScript, `check` = build + `node --test dist/selfcheck.js`) exporting `CONFIG_DIRS`, `listServers()` and `resolveProfileEnv(name?)`; verify `npm run check -w packages/core` runs
- [ ] 1.2 Selfcheck in `packages/core/src/selfcheck.ts` with temp folders covering every server-profiles scenario: folder order, `.env.example` ignored, traversal `x/../.env.prod` refused without reading, case mismatch refused, omitted server → default, no merge across files, host/user/password never from process env, file beats env; verify all pass

## 2. Engines become mountable kit packages (unified-server spec, design D2–D6)

- [ ] 2.1 Rename screen to `@ibmi-agent-kit/screen` (bin `ibmi-agent-kit-screen`, `exports` map, author/contributors), split `src/index.ts` into `tools.ts` (`register(mcp, opts)` returning `shutdown`) and a bootstrap `index.ts`, switch `config.ts` to `resolveProfileEnv`, add modification notices; verify `npm run check -w packages/screen` passes all existing checks
- [ ] 2.2 Same for source as `@ibmi-agent-kit/source` (bin `ibmi-agent-kit-source`); verify `npm run check -w packages/source` passes all existing checks
- [ ] 2.3 Add one selfcheck per engine that importing `./tools.js` installs no process listeners (`process.listenerCount` unchanged for SIGINT, SIGTERM, uncaughtException) and writes nothing to stdout; verify both pass

## 3. Kit server (unified-server spec)

- [ ] 3.1 Create `packages/server` (`@ibmi-agent-kit/server`, bin `ibmi-agent-kit`) that mounts both engines with `listServers: false`, registers one core-backed `list_servers`, owns console redirection, error hooks and a single 5-second shutdown; verify `npm run check -w packages/server` runs
- [ ] 3.2 Selfcheck over an in-memory MCP client/server pair: combined tool list contains the five named tools, `list_servers` exactly once; a forced duplicate registration aborts startup naming the tool; shutdown with stub engines calls both and resolves within 5 s even when one never settles; verify all pass
- [ ] 3.3 Selfcheck that spawns `node packages/server/dist/index.js`, sends `initialize` + `tools/list` on stdin and parses every stdout line as JSON-RPC; verify it passes on this Windows host

## 4. Repo reset and docs

- [ ] 4.1 Root `package.json` check script runs core, screen, source, server in order; verify a clean `rm -rf packages/*/dist && npm run check` passes
- [ ] 4.2 Rewrite `README.md` (what the kit is, install and register `ibmi-agent-kit` with Claude Code, profiles and their folders, PUB400 notes incl. `IBMI_SSH_PORT=2222`, the transport requirement: SSH plus a Mapepire jar upload for SQL, migration from the old server names, Built on), `CLAUDE.md` (layout, rules, how to check), `docs/idea.md` (execute-and-guard direction, roadmap: unified-kit → execution-guard → project-verbs → pilot), and `NOTICE` (hard-fork wording); verify every command shown in README runs as written on this host
- [ ] 4.3 Grep the tracked tree for the private-names list kept outside the repo and for `knowledge pack`; verify zero hits

## Workflow follow-up

- Archive with `/opsx:archive` after review, syncing specs into `openspec/specs/`.
