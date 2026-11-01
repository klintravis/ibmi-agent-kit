## Why

Nothing lets a newcomer see the guard, verbs and config bootstrap work against their own IBM i
in a few minutes. A tested, ready-to-paste demo does.

## What Changes

- `docs/demo.md`: quick-start demo (setup, one prompt per stage with expected results).
- `examples/demo/`: observe and enforce policies and their `policy test` files, placeholder names.
- `packages/server/src/selfcheck.ts`: a test that runs `policy test` on both demo policies.
- README: a "Try it" link.
- `.claude/skills/demo/SKILL.md`: a `/demo` skill that walks the user through `docs/demo.md`,
  waiting at each human step; the profile password is never seen by the agent. A selfcheck test
  keeps its tool names and paths real.

Out of scope: any new script, option or MCP tool (none added or changed); a live run by CI;
real library or user names.

## Impact

`docs/demo.md`, `examples/demo/*`, `packages/server/src/selfcheck.ts`, `README.md`, `.claude/skills/demo/SKILL.md`.
