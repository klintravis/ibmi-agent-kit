## Why

`npm run check` prints about 54 KB of TAP for 309 tests across five packages. Agents and CI logs
only need failures; the noise costs context and hides the one red line.

## What Changes

- Each package's `check` script runs `node --test --test-reporter=dot dist/selfcheck.js`: one dot
  per passing test, and for a failure the test name, assertion message, diff and stack.
- **BREAKING (minor):** `engines.node` rises from `>=18` to `>=18.15` in the five packages and
  the `config.yaml` context line, because `--test-reporter` first shipped in 18.15 (and 19.6).
  CI's Node 18 leg resolves to the latest 18.x, so it is unaffected.

Out of scope: package source and tests, no MCP tools added or changed, no custom reporter, no
printed pass/fail totals (the dot reporter prints none; the exit code and the absence of a
"Failed tests" section are the signal).

## Impact

`package.json` of core, guard, screen, server, source; `openspec/config.yaml`; root, screen and source
READMEs (Node version text).
