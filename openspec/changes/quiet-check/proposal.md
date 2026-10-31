## Why

`npm run check` prints about 54 KB of TAP for 309 tests across five packages. Agents and CI logs
only need failures; the noise costs context and hides the one red line.

## What Changes

- Each package's `check` script runs `node --test --test-reporter=dot dist/selfcheck.js`: one dot
  per passing test, and for a failure the test name, assertion message, diff and stack.
- **BREAKING (minor):** `engines.node` rises from `>=18` to `>=20` in the five packages, the
  `config.yaml` context line, the READMEs and the CI matrix (now Node 20 and 22). Owner ruling
  (2026-10-31): drop Node 18. CI run 41215541271 showed the dot reporter on Node 18 prints only `X`
  for a failure, with no test name or message. Node 18 is EOL since April 2025 and
  `@hono/node-server` in the lockfile already needs `>=20`.

Out of scope: package source and existing tests, no MCP tools added or changed, no custom reporter, no
printed pass/fail totals (the dot reporter prints none; the exit code and the absence of a
"Failed tests" section are the signal).

## Impact

`package.json` of core, guard, screen, server, source; `openspec/config.yaml`; `.github/workflows/check.yml`; `package-lock.json`;
`packages/core/src/selfcheck.ts`; root, screen and source
READMEs (Node version text).
