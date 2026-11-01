# Tasks

## 1. setup command

- [x] 1.1 Export `serverName` and `parseProfile` from core and re-export `loadProfile` from `@ibmi-agent-kit/source/tools` (modification line updated); verify `npm run build` passes
- [x] 1.2 `packages/server/src/setup-cli.ts` and the `setup` dispatch in `src/index.ts`: name check, TTY refusal, raw-mode prompts, dotenv-safe update, atomic write, test connection, scrubbed one-line result; verify with 1.3
- [x] 1.3 `src/setup-selfcheck.ts` loaded by `src/selfcheck.ts`: new file, update keeping lines, hostile password and Windows policy path round-trip via `resolveProfileEnv`, policy made absolute, bad names, non-TTY (in process and through the binary), Ctrl-C, backspace, failed connection, password absent from all output; verify the `setup` tests in `node --test dist/selfcheck.js` pass
- [x] 1.4 Document `setup` in `packages/server/README.md` and the root README (Install, Profiles); verify docs-check passes

## 2. Skills and demo guide

- [x] 2.1 `.claude/skills/demo/SKILL.md`: kit path from `claude mcp get ibmi-agent-kit`, approval states and re-enable steps, `setup <name>` in the user's own terminal, Part D from a terminal; verify the demo skill selfcheck passes
- [x] 2.2 `docs/demo.md`: profile via `setup`, registration env versus profile file (viewer note), Part D from a terminal; verify docs-check passes
- [x] 2.3 `.claude/skills/ibmi-kit-config/SKILL.md` Bootstrap step 1: refuse a folder that is not an empty company repo, Maintain when `policy.yaml` exists; verify by reading the step against the spec scenario

## 3. Verify

- [x] 3.1 `openspec validate first-run --strict`, `node scripts/check-names.mjs`, docs-check and `npm run clean && npm run check` all pass
