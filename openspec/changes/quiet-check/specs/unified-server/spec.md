## MODIFIED Requirements

### Requirement: One stdio server mounts every engine
The kit SHALL provide one MCP server over stdio, started by the `ibmi-agent-kit` command, that
exposes every screen-engine and source-engine tool. It SHALL run on Node 20 or later on Windows,
macOS and Linux without Docker.

#### Scenario: Combined tool list
- **WHEN** a client starts `ibmi-agent-kit` and lists tools
- **THEN** the list contains `session_open`, `screen_do`, `run_sql`, `compile_member` and `list_servers`
