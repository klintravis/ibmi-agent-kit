# Spec Delta

## MODIFIED Requirements

### Requirement: The guided demo sets up the profile through setup
The `demo` skill and `docs/demo.md` SHALL have the user create the profile either on the sign-on page the
server offers or by running `setup <name>` in their own terminal, never by editing the profile file and
never by giving the password to Claude. The skill SHALL build the `setup` command from the kit path in
`claude mcp get ibmi-agent-kit`, not ask or search for it.

#### Scenario: Profile step
- **WHEN** the skill reaches the profile step
- **THEN** it shows `node <kit>/packages/server/dist/index.js setup <name>` with `<kit>` taken from the registered server's arguments, and waits

#### Scenario: Page route
- **WHEN** the skill reaches the profile step with no profile and `list_servers` offers the page
- **THEN** it tells the user to enter the details on the page, uses the `default` profile afterwards, and
  never asks for the password
