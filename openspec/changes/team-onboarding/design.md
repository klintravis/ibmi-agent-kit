# Design

## Context

`setup` (change `first-run`, merged, not yet archived) lives in `packages/server/src/setup-cli.ts`:
`setupCli(args, deps)` asks host, user, hidden password and policy through one raw-mode reader,
checks the policy with `loadPolicy`, proves the new text reads back, writes atomically to the first
profile folder, then reads the profile back and runs the test SELECT. `deps` already injects stdin,
writers and `connect`; `setup-selfcheck.ts` drives it with a fake TTY in a temp config folder.

The `ibmi-kit-config` skill writes the company repo with the client's file tools; the kit's
`templates/dry-run/` is its worked example, checked by the dry-run test in
`packages/server/src/selfcheck.ts`. Skeletons today carry `IBMI_KIT_POLICY=<absolute path to this
repo>/policy.yaml`, a path valid only on the admin's machine.

`IBMI_KIT_POLICY` is protected (profile file only, `packages/core/src/index.ts` `PROTECTED`), by
design: only the person whose credentials a policy guards can point a profile at it. That is why
`setup` writes it rather than the repo or the MCP registration.

## Goals / Non-Goals

**Goals:** one code path for both modes; company-repo mode only changes where host, partition and
policy come from and which questions are skipped.

**Non-Goals:** a second command or flag; a general skeleton importer; any change to the write,
read-back or test steps.

## Decisions

- **Detection: the current folder only.** Company-repo mode when `<cwd>/policy.yaml` is a file and
  `<cwd>/profiles` a folder. No walk up to the git root: no git dependency, and the README's steps
  are clone, `cd`, `setup`, `claude` in the same folder, the folder `claude` must start in for
  `.mcp.json` anyway. `setup` prints `company config repo: <cwd>` so the mode is visible.
  Alternative, the git root: more code, and a subfolder start would then work for `setup` but not
  for `claude`. `cwd` joins `SetupDeps` (default `process.cwd()`), as `connect` did; no `chdir`.
- **Partitions from the loader's rules.** `readdirSync(profiles)` mapped through core's
  `serverName`, then `fileFor`, so `.env.example`, `.bak`, `.orig` and bad names drop out exactly
  as in the loader. None found: refuse (exit 2). A name argument must be one of them, else exit 2
  listing them. No argument: one partition is taken as is; several are offered as a numbered list
  read with the existing visible prompt, answered by number or name. The profile name is the
  partition.
- **Values.** Skeleton parsed with `parseProfile`. `IBMI_HOST` and `IBMI_PARTITION` come from it
  (either missing: exit 2, naming the file). `IBMI_USER`: the existing profile's value is the
  default, never the skeleton's placeholder. Password: unchanged prompt. `IBMI_KIT_POLICY` =
  `resolve(cwd, "policy.yaml")`, through the existing `loadPolicy` check before the write; when the
  existing profile names another path, one line says it is replaced. The host and policy prompts are
  skipped. Every other skeleton key is ignored (proposal, Out of scope).
- **Skeleton password: ignore and warn, not refuse.** The skeleton is the admin's file; refusing
  would block every colleague over the admin's mistake. The warning names the file and says to
  remove it from the repo and its history and change that password. Its value never enters the
  values written.
- **No password in the repo.** `setup` writes only the profile file and its temp file, both in the
  first profile folder. If that folder is the repo or inside it (`relative(cwd, dir)` neither starts
  with `..` nor is absolute), refuse before the first prompt (exit 2): an `IBMI_KIT_CONFIG_DIR`
  pointing into the clone would otherwise commit-stage a password.
- **`.mcp.json` command: `"command": "node", "args": ["${IBMI_KIT_HOME}/packages/server/dist/index.js"]`**
  (command and path as separate fields; one string in `command` would not spawn). Claude Code
  expands `${VAR}` in a `.mcp.json` `command`, `args` and `env` (docs: `mcp.md`, environment
  variable expansion); an unset variable without a default still loads the config, keeps the
  `${VAR}` text as is, and `claude mcp list` reports a missing-variable warning, so the server then
  fails to start rather than the whole file. The
  file must be committed and shared, so it cannot hold the admin's absolute kit path, and `npx
  ibmi-agent-kit` resolves to nothing until the kit is published (T-54); the published bin is in
  `@ibmi-agent-kit/server`. Interim until then: `IBMI_KIT_HOME` names each person's kit checkout.
  `setup` closes the loop: in company-repo mode, when the repo's `.mcp.json` contains
  `${IBMI_KIT_HOME}` and the variable is unset, it prints the kit folder it runs from (three levels
  above `dist/setup-cli.js`) as the value to set. Once published, the bootstrap writes the `npx`
  form instead and the hint stops firing by itself. `env` holds only `IBMI_5250_VIEWER: "true"`, a
  non-protected setting, as the example.
- **Bootstrap replaces the session's `.mcp.json`.** Step 1 still accepts one registering
  ibmi-agent-kit; step 5 overwrites it with the generated one (same server name). The skill's kit
  path lookup (`claude mcp get ibmi-agent-kit`, `Args:` line) prefers `$IBMI_KIT_HOME` when set,
  since a Maintain session now runs under the generated registration.
- **README "Get started".** The section lives in `templates/company-repo/README.md`, which the
  skill copies and fills. The five steps as the spec lists them, the repo-local form being
  `node <kit>/packages/server/dist/index.js setup` with `IBMI_KIT_HOME` set to `<kit>`; `/demo`
  is marked optional and as a skill of the kit checkout. One line on why the policy path is in
  each profile. The template's Profiles section switches from "copy the skeleton" to `setup`.
- **Selfchecks.**
  - `setup-selfcheck.ts`: a temp company repo (a copy of `examples/demo/policy-observe.yaml` as
    `policy.yaml`, two skeletons, one with `IBMI_PASSWORD`, `.mcp.json` from the dry-run fixture);
    hash every repo file before and after; assert the profile's `IBMI_HOST`, `IBMI_PARTITION`,
    `IBMI_KIT_POLICY` (absolute, the repo's), the password warning, the `IBMI_KIT_HOME` hint, no
    repo file containing the password, the menu, an unknown name (exit 2) and a config folder
    inside the repo (exit 2, nothing written).
  - `selfcheck.ts` dry-run test: `.mcp.json` parses, registers `ibmi-agent-kit`, has no absolute
    path in `command`/`args`; each `env` key, set in `process.env`, comes back from
    `resolveProfileEnv` for a profile lacking it (so it is not protected, without exporting core's
    list); README has `## Get started` with `setup`, `claude`, approve and `/demo` in order; no
    skeleton holds `IBMI_KIT_POLICY`.

## Risks / Trade-offs

- [`IBMI_KIT_HOME` is one more thing a colleague sets before publication] → `setup` prints the exact
  value; the README step 2 names it; it disappears with the `npx` form.
- [A colleague starts `claude` in a subfolder] → the server is not registered there either; the
  README says to run both in the repo root.
- [Skeleton keys other than host and partition (transport, ports, guards) are not applied] → the
  bootstrap asks each partition's transport (Q16), and `IBMI_SQL_TRANSPORT` is protected, so a
  company that answered `mapepire` gets colleague profiles on the `ssh` default and a failing
  connection test. Open owner question: copy the skeleton's non-credential keys too (all but
  `IBMI_USER`, `IBMI_PASSWORD`, `IBMI_KIT_POLICY`). Until ruled, the README's Get started tells a
  colleague to add the skeleton's other lines to the profile by hand.
- [`IBMI_5250_VIEWER=true` in a shared file turns the viewer on for everyone] → it is the
  owner-chosen example; each person may delete it locally only by editing the committed file, so
  the README says what it does.

## Migration Plan

Archive `first-run` before this change. Existing company repos keep working: `setup` ignores a
skeleton's old `IBMI_KIT_POLICY` line; the admin regenerates `.mcp.json` and the README section on
the next Maintain run or copies them from the template.
