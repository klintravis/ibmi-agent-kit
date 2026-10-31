## Decision

Use the built-in `dot` reporter, not `spec` (still one line per test, ~25 KB) and not a custom
reporter file (new code to maintain, same Node floor). Alternatives (piping through grep, or `--test` flags) are not portable to Windows and would hide
assertion detail.

The Node floor is 20, not 18.15: CI run 41215541271 showed the dot reporter on Node 18 prints only
`X` for a failure, with no test name or message (the canary selfcheck failed on all three Node 18
jobs; Node 22 passed). Owner ruling 2026-10-31: drop Node 18, which is EOL and already excluded by
`@hono/node-server` (`>=20`). The canary selfcheck stays and verifies the scenario on every CI leg.

Measured on Node 22: guard output 22.7 KB (TAP) falls to about 0.3 KB; a failing test still prints
`✖ name`, the assertion message, `1 !== 2` style diff and stack under "Failed tests:".
