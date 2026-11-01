# config-bootstrap Specification

## Purpose
Gives an admin a guided, repeatable way to create and keep current a company's kit configuration
from what their IBM i already says about itself.

## Requirements

### Requirement: Templates are valid, tested and invented
The repository SHALL ship policy templates `single-partition-ladder`, `two-partition`,
`three-lpar` and `per-developer-libs`, each in observe mode, commented, using invented names, and
each with a test file that `ibmi-agent-kit policy test` passes.

#### Scenario: Template suite
- **WHEN** `policy test` runs each template against its test file
- **THEN** every case passes and the private-name check reports no hits

### Requirement: Discovery is read-only
Every query the skill runs during discovery SHALL be a `SELECT` or `VALUES` sent through the kit's
read-only tools, and the skill SHALL state before starting that results are limited to what the
admin's own profile may read.

#### Scenario: Limited authority
- **WHEN** the admin's profile cannot read other users' profiles
- **THEN** the skill reports which discovery steps returned partial results and continues

### Requirement: The skill asks only what it cannot discover
The skill SHALL infer partitions, library ladder prefixes, personal-library convention, candidate
roles and candidate promote commands from discovery, present each inference with its evidence, and
ask the admin one question at a time to confirm or correct it, offering a recommended answer.

#### Scenario: Ladder inferred
- **WHEN** discovery finds libraries clustered under prefixes `DV`, `IN`, `SQ`, `SP`
- **THEN** the skill proposes that order as the ladder with library counts as evidence, and asks the admin to confirm the order

### Requirement: Generated configuration is safe by default
Generated `policy.yaml` SHALL be in observe mode, SHALL pass `policy test` with the generated
`policy.tests.yaml`, and SHALL contain one allow and one deny case per role and environment.
Generated profile files SHALL NOT contain a password value.

#### Scenario: First run output
- **WHEN** bootstrap completes
- **THEN** the company repo holds profile skeletons without passwords, an observe-mode policy, its
  passing tests, a command file, a `verbs/` folder with one smoke verb, and a README

### Requirement: Maintenance proposes reviewed changes
On a maintenance run the skill SHALL re-discover, report differences from the policy (libraries in
`unmatched`, unmapped groups, new systems or RDBs, products added or removed), summarise the run log
(`unmatched`, `default_role`, frequent `confirm`), show a `policy replay` of its proposed edit, and
leave the edit with updated tests on a branch, never on the default branch.

#### Scenario: New library prefix
- **WHEN** a new `UA*` library family appears that no environment matches
- **THEN** the skill reports it with counts, proposes an environment entry, adds test cases, and shows the replay result

### Requirement: The skill is not shipped to end users
Published kit packages SHALL NOT include the skill or the templates.

#### Scenario: Packed contents
- **WHEN** a kit package is packed
- **THEN** the archive contains no `.claude/` or `templates/` paths

### Requirement: The bootstrap starts in an empty company repo
The `ibmi-kit-config` bootstrap SHALL refuse a folder that holds anything besides `.git`, `README*`,
`LICENSE*`, `.gitignore` and the session's own Claude Code files (a `.mcp.json` registering
ibmi-agent-kit, a `.claude` folder with only `skills/` and `settings.local.json`), naming what it
found and why; a folder with this kit's `policy.yaml` SHALL go to Maintain instead.

#### Scenario: Wrong folder
- **WHEN** the working folder has a `package.json` or a `packages/` folder and no `policy.yaml`
- **THEN** the skill stops, names those entries, and writes nothing

### Requirement: Bootstrap registers the kit server for the team
The bootstrap SHALL generate a `.mcp.json` in the company repo that registers the kit server under
the name `ibmi-agent-kit` without a machine-specific path, and whose `env` holds
`IBMI_5250_VIEWER` set to `true` and no protected profile setting. It replaces a `.mcp.json` the
session brought in.

#### Scenario: Registration file
- **WHEN** bootstrap completes
- **THEN** the repo's `.mcp.json` registers `ibmi-agent-kit`, its command holds no absolute path of
  the admin's machine, and every key in its `env` is one the profile loader takes from the
  environment

### Requirement: Bootstrap README gets a colleague started
The generated README SHALL hold a "Get started" section listing, in order: clone the repo, run the
kit's repo-local `setup` command (with `npx ibmi-agent-kit setup` labelled "once published"), run
`claude`, approve the server, and optionally `/demo` from the kit checkout. One line SHALL say the policy path lives in each user's
profile because only the person whose credentials it protects can point at a policy.

#### Scenario: Get started section
- **WHEN** bootstrap completes
- **THEN** the README's "Get started" section names those steps in that order and the line on why
  the policy path is in the profile

### Requirement: Profile skeletons carry no machine path
Generated profile skeletons SHALL NOT contain `IBMI_KIT_POLICY` or a password value; their comment
SHALL tell the reader to run `setup` in the repo.

#### Scenario: Skeleton contents
- **WHEN** bootstrap writes `profiles/.env.<partition>`
- **THEN** it holds the host, a placeholder user, the transport and `IBMI_PARTITION`, and no
  `IBMI_KIT_POLICY` or `IBMI_PASSWORD` line

### Requirement: The dry-run fixture holds every generated file
The kit's bootstrap dry-run fixture SHALL include the generated `.mcp.json` and `README.md`, and the
kit's checks SHALL verify them against the requirements above.

#### Scenario: Fixture checked
- **WHEN** `npm run check` runs
- **THEN** it fails if the fixture's `.mcp.json` or README "Get started" section is missing or breaks
  these requirements
