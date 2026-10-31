## Why

`docs-check` reports three packages without a README (core, guard, server), two tools named in no
doc (`policy_check`, `run_script`), and no policy-file reference. The root README still says the
guard "is coming in the next change".

## What Changes

- READMEs for `packages/core`, `packages/guard`, `packages/server`.
- Root README: Tools table (every registered tool), Safety section, links to all package READMEs.
- `docs/policy.md`: the policy file reference.

Out of scope: any code change; no MCP tools added or changed (the table documents existing ones with
their read-only or destructive annotations); the guard is not yet wired into the screen and source
tools, and the catalog lookups are not yet verified on a live box, and the docs say so.

## Impact

`README.md`, `packages/{core,guard,server}/README.md`, `docs/policy.md`.
