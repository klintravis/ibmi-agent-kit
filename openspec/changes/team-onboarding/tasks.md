# Tasks

## 1. setup in a company config repo

- [x] 1.1 In `packages/server/src/setup-cli.ts`, add `cwd` to `SetupDeps` (default
  `process.cwd()`) and the company-repo mode from design.md: detection in `cwd` only, partitions via
  core's `serverName` over `profiles/`, menu or name check (exit 2 on unknown or none), every
  skeleton key but `IBMI_USER`/`IBMI_PASSWORD`/`IBMI_KIT_POLICY` copied (host or partition
  missing: exit 2), user and hidden password asked, `IBMI_KIT_POLICY` =
  `resolve(cwd, "policy.yaml")` through the existing `loadPolicy` check, "replaces" line, skeleton
  `IBMI_PASSWORD` ignored with a warning, refusal when the first profile folder is inside `cwd`, the
  `IBMI_KIT_HOME` hint when `.mcp.json` uses it and it is unset. Outside a company repo nothing
  changes; verify with the existing setup selfchecks still passing.
- [x] 1.2 In `packages/server/src/setup-selfcheck.ts`, add the temp-company-repo cases listed in
  design.md (Selfchecks): written `IBMI_HOST`/`IBMI_PARTITION`/absolute `IBMI_KIT_POLICY`, a
  non-credential key (`IBMI_SQL_TRANSPORT`) copied and the skeleton's `IBMI_PASSWORD` not, repo
  files byte-identical and password-free, password warning, menu, unknown name, single skeleton,
  config folder inside the repo, the hint on and off; verify with `npm run clean && npm run check`
  exit 0.
- [x] 1.3 Document company-repo mode in the `setup` section of `packages/server/README.md`;
  verify docs-check passes.

## 2. Bootstrap generates the team files

- [x] 2.1 Update `.claude/skills/ibmi-kit-config/SKILL.md`: the generated-files list gains
  `.mcp.json`; skeletons (step 5) drop `IBMI_KIT_POLICY` and say "run setup in this repo"; step 5
  writes `.mcp.json` (`"command": "node"`, `"args": ["${IBMI_KIT_HOME}/packages/server/dist/index.js"]`, env
  `IBMI_5250_VIEWER: "true"`), replacing the session's one; the kit-path lookup prefers
  `$IBMI_KIT_HOME`. Verify by reading the skill against the config-bootstrap delta.
- [x] 2.2 Update `templates/company-repo/README.md`: tree gains `.mcp.json`, Profiles section says
  run `setup`, new "Get started" section (clone, the repo-local `setup` command with
  `IBMI_KIT_HOME` and `npx ibmi-agent-kit setup` labelled "once published", `claude`, approve the
  server, `/demo` optional and from the kit checkout) with the one line on why the policy path
  lives in each profile.
- [x] 2.3 Update `templates/dry-run/`: add `.mcp.json` and `README.md` (generated per 2.1/2.2),
  remove the `IBMI_KIT_POLICY` line and fix the comment in `profiles/.env.*`.
- [x] 2.4 Extend the dry-run test in `packages/server/src/selfcheck.ts` per design.md (Selfchecks):
  `.mcp.json` parses, registers `ibmi-agent-kit`, no absolute path, env keys not protected (checked
  through `resolveProfileEnv`); README "Get started" steps in order; no skeleton holds
  `IBMI_KIT_POLICY`. Verify `npm run clean && npm run check` exit 0 and that removing the fixture's
  `.mcp.json` makes it fail.

## 3. Docs and integration

- [ ] 3.1 Root `README.md` Install: one paragraph "In a company config repo" pointing at the
  company repo's Get started; `docs/demo.md` Part D: copying the demo's `.mcp.json` into the empty
  repo still works, the bootstrap then replaces it with the portable one. Verify with
  `node C:/IbmiKit/Source/desk/scripts/docs-check.mjs .` and `node scripts/check-names.mjs`.
- [ ] 3.2 Run `npm run clean && npm run check` and `openspec validate team-onboarding --strict`;
  both exit 0.

## Workflow follow-up

- Fresh review, merge, then archive `team-onboarding`.
- When the kit is published (T-54), switch the generated `.mcp.json` and README step 2 to the `npx`
  form.
