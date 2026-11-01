# Proposal

## Why

The policy format can express many shops, but a blank YAML file is a poor start: an admin has to
know their partitions' system and RDB names, which library prefixes form the change-management
ladder, which groups and authorization lists mean "developer" or "QA", and how their
change-management product's promote command is shaped — and keep all of that current as the shop
changes. Most of it can be read from the box. A guided session that discovers, asks only what it
cannot discover, and writes a tested starting configuration makes adoption a short session
instead of a project.

## What Changes

- New Claude skill in this repository, `.claude/skills/ibmi-kit-config/`, for **admins setting up
  and maintaining a company's kit configuration** (not shipped to end users with the MCP; excluded
  from the published packages). It runs in a session where the kit MCP is connected to the
  company's IBM i, with the company's private config repo as the working directory.
  - **Bootstrap:** read-only discovery of partitions, RDBs and IASPs, libraries and their owners
    and long names, users, groups, authorization lists, who holds change authority on which
    libraries, job description library lists, and installed change-management products and their
    commands; inference of the ladder, personal-library convention and roles; one question at a
    time for what it cannot infer; generation of profile skeletons (no passwords), `policy.yaml`
    from the nearest template in observe mode, a command file for the change-management product,
    `policy.tests.yaml`, a `verbs/` folder with one smoke verb, and a README; then `policy test`
    and live `policy_check` per role.
  - **Maintain:** re-discover and diff against the policy (new libraries in `unmatched`, new
    groups, new systems or RDBs, products added or removed), read the run log for `unmatched`,
    `default_role` and frequent `confirm` hits, run `policy replay` on the proposed edit, and leave
    the change as a branch for review.
- New **policy templates** with test files: `single-partition-ladder`, `two-partition`,
  `three-lpar`, `per-developer-libs`, each commented, invented-name, observe mode.
- A **discovery query reference** the skill uses, each query marked with the IBM i release it needs.

### MCP tools added or changed

None. Discovery uses `run_sql` (read-only) and `policy_check`; files are written by the client's own
file tools, consistent with "no tool writes configuration".

## Out of scope

- An MCP tool that writes policy, profile or verb files.
- Storing or prompting for passwords; profile skeletons leave `IBMI_PASSWORD` for the admin.
- Product-specific command files beyond one invented example; real products' tables are written per
  company by the skill from what it discovers.

## Capabilities

### New Capabilities
- `config-bootstrap`: the admin skill's bootstrap and maintenance behaviour, its templates and its
  safety rules.

### Modified Capabilities
- None.

## Impact

- New `.claude/skills/ibmi-kit-config/` (`SKILL.md`, `references/discovery.md`,
  `references/questions.md`), `templates/policies/*.yaml` and `*.tests.yaml`,
  `templates/company-repo/README.md`.
- Root `package.json` `files`/packaging excludes `.claude/` and `templates/` from published packages.
- Depends on `execution-guard` (`policy test`, `policy_check` with `policy`/`as`) and
  `project-verbs` (verb format).
