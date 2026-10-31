## MODIFIED Requirements

### Requirement: One stdio server mounts every engine
The kit SHALL provide one MCP server over stdio, started by the `ibmi-agent-kit` command, that
exposes every screen-engine and source-engine tool. It SHALL run on Node 20 or later on Windows,
macOS and Linux without Docker.

#### Scenario: Combined tool list
- **WHEN** a client starts `ibmi-agent-kit` and lists tools
- **THEN** the list contains `session_open`, `screen_do`, `run_sql`, `compile_member` and `list_servers`

### Requirement: The checks run on every supported platform
The repository SHALL run the root check on Windows, macOS and Linux with Node 20 and Node 22 for
every push and pull request.

#### Scenario: Matrix run
- **WHEN** a commit is pushed
- **THEN** the check workflow runs six jobs and fails if any package check fails
