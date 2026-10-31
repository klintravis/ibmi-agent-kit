## Decision

Use the built-in `dot` reporter, not `spec` (still one line per test, ~25 KB) and not a custom
reporter file (new code to maintain, same Node floor). Alternatives that keep Node 18.0 (piping
through grep, or `--test` flags) are not portable to Windows and would hide assertion detail.

Measured on Node 22: guard output 22.7 KB (TAP) falls to about 0.3 KB; a failing test still prints
`✖ name`, the assertion message, `1 !== 2` style diff and stack under "Failed tests:".
