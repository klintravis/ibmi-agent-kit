# Spec Delta

## ADDED Requirements

### Requirement: The guided demo sets up the profile through setup
The `demo` skill and `docs/demo.md` SHALL have the user create the profile by running `setup <name>`
in their own terminal, never by editing the profile file and never through Claude. The skill SHALL
build that command from the kit path in `claude mcp get ibmi-agent-kit`, not ask or search for it.

#### Scenario: Profile step
- **WHEN** the skill reaches the profile step
- **THEN** it shows `node <kit>/packages/server/dist/index.js setup <name>` with `<kit>` taken from the registered server's arguments, and waits

### Requirement: The guided demo explains a hidden project server
The `demo` skill SHALL check `claude mcp get ibmi-agent-kit` before connecting and, for a pending,
rejected or disabled project server, tell the user the documented way to approve or re-enable it.

#### Scenario: Rejected server
- **WHEN** `claude mcp get ibmi-agent-kit` shows the server as rejected
- **THEN** the skill tells the user to run `claude mcp reset-project-choices` and restart `claude`, or remove the name from `disabledMcpjsonServers`

### Requirement: Registration env versus profile file is documented
`docs/demo.md` SHALL say that non-protected settings such as `IBMI_5250_VIEWER` may be set in the
MCP registration's env and that protected settings come only from the profile file.

#### Scenario: Live viewer setting
- **WHEN** a reader wants the live 5250 view in the demo
- **THEN** the guide shows `IBMI_5250_VIEWER=true` in the registration env and says `IBMI_5250_VIEWER_PORT` belongs in the profile
