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
- **Values.** Skeleton parsed with `parseProfile`. Every skeleton key except `IBMI_USER`,
  `IBMI_PASSWORD` and `IBMI_KIT_POLICY` is copied into the profile (desk ruling (d)), so a skeleton
  with `IBMI_SQL_TRANSPORT=mapepire`, ports or guards gives a working profile; `IBMI_HOST` and
  `IBMI_PARTITION` must be among them (either missing: exit 2, naming the file). `IBMI_USER`: the
  existing profile's value is the default, never the skeleton's placeholder. Password: unchanged
  prompt. `IBMI_KIT_POLICY` = `resolve(cwd, "policy.yaml")`, through the existing `loadPolicy`
  check before the write; when the existing profile names another path, one line says it is
  replaced. The host and policy prompts are skipped.
- **Skeleton password: ignore and warn, not refuse.** The skeleton is the admin's file; refusing
  would block every colleague over the admin's mistake. The warning names the file and says to
  remove it from the repo and its history and change that password. Its value never enters the
  values written.
- **No password in the repo.** `setup` writes only the profile file and its temp file, both in the
  first profile folder. If that folder, or a partition's profile file in it, resolves (symlinks
  followed, through the nearest existing folder) to the repo or inside it, refuse before the first
  prompt (exit 2): an `IBMI_KIT_CONFIG_DIR` pointing into the clone, or a profile linked into it,
  would otherwise commit-stage a password.
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
  skill copies and fills. The five steps as the spec lists them; step 2 is the repo-local
  `node <kit>/packages/server/dist/index.js setup` (then `IBMI_KIT_HOME` set to the folder setup
  prints), with `npx ibmi-agent-kit setup` beside it labelled "once published" (desk ruling (b));
  `/demo` is marked optional and "from the kit checkout" (ruling (c)). One line on why the policy path is in
  each profile. The template's Profiles section switches from "copy the skeleton" to `setup`.
- **Selfchecks.**
  - `setup-selfcheck.ts`: a temp company repo (a copy of `examples/demo/policy-observe.yaml` as
    `policy.yaml`, two skeletons, one with `IBMI_PASSWORD` and `IBMI_SQL_TRANSPORT`, a `.mcp.json`
    of the generated shape); compare every repo file before and after; assert the profile's
    `IBMI_HOST`, `IBMI_PARTITION`, the copied `IBMI_SQL_TRANSPORT`, `IBMI_KIT_POLICY` (absolute,
    the repo's), the skeleton password not written, the password warning, the `IBMI_KIT_HOME` hint, no
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
- [Skeleton keys other than host and partition (transport, ports, guards)] → resolved by desk
  ruling (d): all are copied except `IBMI_USER`, `IBMI_PASSWORD` and `IBMI_KIT_POLICY`, so a
  company that answered `mapepire` (Q16) gets colleague profiles on `mapepire`. A key the admin
  later removes from a skeleton stays in profiles already written; the next `setup` run does not
  delete it.
- [`IBMI_5250_VIEWER=true` in a shared file turns the viewer on for everyone] → it is the
  owner-chosen example; each person may delete it locally only by editing the committed file, so
  the README says what it does.

## Open Questions

- Who owns the npm name `ibmi-agent-kit` (T-84, owner). Until ruled, the README's step 2 is the
  repo-local command and the `npx` form is labelled "once published".

## Migration Plan

Archiving `first-run` is a separate step, not in this branch. Existing company repos keep working: `setup` ignores a
skeleton's old `IBMI_KIT_POLICY` line; the admin regenerates `.mcp.json` and the README section on
the next Maintain run or copies them from the template.
