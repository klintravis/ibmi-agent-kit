# Spec Delta

## Purpose

Gives a user one MCP server to register that carries every kit engine, with a single process
lifecycle so sessions on the IBM i are always closed cleanly.

## ADDED Requirements

### Requirement: One stdio server mounts every engine
The kit SHALL provide one MCP server over stdio, started by the `ibmi-agent-kit` command, that
exposes every screen-engine and source-engine tool. It SHALL run on Node 18 or later on Windows,
macOS and Linux without Docker.

#### Scenario: Combined tool list
- **WHEN** a client starts `ibmi-agent-kit` and lists tools
- **THEN** the list contains `session_open`, `screen_do`, `run_sql`, `compile_member` and `list_servers`

### Requirement: Engine tools behave as they do standalone
Each mounted tool SHALL accept the same inputs and return the same results as when its engine
runs on its own. Each engine SHALL remain runnable on its own through its own command.

#### Scenario: Standalone engine
- **WHEN** `ibmi-agent-kit-screen` is started and lists tools
- **THEN** it returns the screen tools only, and the screen package's own checks pass

### Requirement: Tool names are unique
The server SHALL expose `list_servers` exactly once. Any other tool name provided by two engines
SHALL stop the server at startup with an error naming the tool.

#### Scenario: list_servers once
- **WHEN** the kit's tools are listed
- **THEN** `list_servers` appears exactly once

#### Scenario: Unexpected duplicate
- **WHEN** two engines register the same tool name other than `list_servers`
- **THEN** startup fails with an error naming that tool

### Requirement: One shutdown closes everything
On SIGINT or SIGTERM the server SHALL sign off every open 5250 session and close every SQL
connection, waiting at most 5 seconds in total, before the process exits. Engines mounted in the
server SHALL NOT install their own process signal handlers.

#### Scenario: Sign-off before exit
- **WHEN** the server receives SIGTERM with one 5250 session and one SQL connection open
- **THEN** the session is signed off and the connection closed before the process exits

#### Scenario: Unresponsive host
- **WHEN** a sign-off does not complete
- **THEN** the process still exits within 5 seconds

### Requirement: Standard output carries only protocol messages
While serving, nothing other than MCP protocol messages SHALL be written to standard output;
diagnostics go to standard error.

#### Scenario: Engine logs
- **WHEN** an engine calls `console.log` while handling a tool call
- **THEN** the text appears on standard error and the client's protocol stream stays valid
