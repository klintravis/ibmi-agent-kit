# Spec Delta

## ADDED Requirements

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
The generated README SHALL hold a "Get started" section listing, in order: clone the repo, run
`npx ibmi-agent-kit setup` (or the kit's repo-local command until it is published), run `claude`,
approve the server, and optionally `/demo`. One line SHALL say the policy path lives in each user's
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
