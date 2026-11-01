# Proposal

## Why

A company that has bootstrapped its config repo still hands each colleague a manual: copy a
skeleton, fill in the user, find the repo's absolute path for `IBMI_KIT_POLICY`, register the
server. Onboarding should be "clone the company config repo, run `setup`, run `claude`": the repo
already holds everything but the person's own user and password.

## What Changes

- `ibmi-agent-kit setup [name]` run in a company config repo (the current folder holds
  `policy.yaml` and a `profiles/` folder) takes host and partition from the chosen
  `profiles/.env.<partition>` skeleton, writes `IBMI_KIT_POLICY=<absolute path of the repo's
  policy.yaml>` itself, and asks only the user and the hidden password. The profile is named after
  the partition. No name: it offers the partitions found (no question when there is one); a name
  must be one of them. A skeleton's `IBMI_PASSWORD` is ignored with a warning. It refuses to run
  when the first profile folder lies inside the repo, so a password is never written there. The
  existing write, read-back and connection test are reused unchanged. Outside a company repo,
  `setup` behaves as today.
- In company-repo mode, when `IBMI_KIT_HOME` is not set, `setup` prints the kit folder to set it
  to (the generated `.mcp.json` uses it, below). It writes no environment variable.
- `ibmi-kit-config` bootstrap also generates, in the company repo:
  - `.mcp.json` registering the kit server as `"command": "node"`,
    `"args": ["${IBMI_KIT_HOME}/packages/server/dist/index.js"]`,
    with `"env": { "IBMI_5250_VIEWER": "true" }` as the example of a non-protected setting;
  - a README "Get started" section: clone, `npx ibmi-agent-kit setup` (or the repo-local command
    until it is published), `claude`, approve the server, `/demo` optional; plus one line saying why
    the policy path lives in each user's profile.
- Profile skeletons lose the `IBMI_KIT_POLICY` line (it held the admin's path) and their comment
  says to run `setup` in the repo.
- The dry-run fixture (`templates/dry-run/`) gains `.mcp.json` and `README.md`; selfchecks cover
  both and `setup` in a fake company repo.
- Docs: root README Install, the server README `setup` section, `templates/company-repo/README.md`,
  `docs/demo.md` Part D.

### MCP tools added or changed

None. `setup` is a CLI subcommand; the change adds no tool and changes no annotation.

## Out of scope

- Publishing the kit to npm, and the package name `npx` resolves (T-54). Until then the README
  names the repo-local command.
- Copying skeleton settings other than host and partition (transport, ports, guards) into the
  profile.
- Looking for the company repo above the current folder (no git-root walk).
- Setting `IBMI_KIT_HOME` or any other environment variable for the user, and registering the
  server with `claude mcp add`.
- Making `/demo` available inside the company repo; it stays a skill of the kit checkout.
- Maintain-mode changes to the skill beyond the kit-path lookup.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `server-profiles`: `setup` gains a company-repo mode (skeleton host and partition, automatic
  policy path, no password in the repo).
- `config-bootstrap`: the bootstrap generates `.mcp.json` and the README "Get started" section, and
  profile skeletons carry no policy path.

## Impact

- `packages/server/src/setup-cli.ts`, `packages/server/src/setup-selfcheck.ts`,
  `packages/server/src/selfcheck.ts` (dry-run test), `packages/server/README.md`.
- `.claude/skills/ibmi-kit-config/SKILL.md`, `templates/company-repo/README.md`,
  `templates/dry-run/` (new `.mcp.json`, `README.md`; `profiles/.env.*` edited).
- Root `README.md`, `docs/demo.md`.
- Depends on `first-run` (the `setup` command); archive `first-run` before this change.
- No new dependency.
