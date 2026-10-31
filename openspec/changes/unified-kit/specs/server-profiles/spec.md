# Spec Delta

## Purpose

Defines how the kit finds and loads the named IBM i server profiles a user signs on with, so a
server name always means one file and one box.

## ADDED Requirements

### Requirement: Profiles are searched in a fixed order of folders
Profiles SHALL be searched in `IBMI_KIT_CONFIG_DIR` (when set), then `~/.ibmi-agent-kit`, then
`~/.ibm-i-servers`. A file named `.env` is the `default` server and `.env.<name>` is server
`<name>`; `.env.example` is never a server.

#### Scenario: Shared folder fallback
- **WHEN** only `~/.ibm-i-servers/.env.pub400` exists
- **THEN** `list_servers` includes `pub400` and tools accept `server: pub400`

#### Scenario: Earlier folder wins
- **WHEN** `.env.pub400` exists in both `~/.ibmi-agent-kit` and `~/.ibm-i-servers`
- **THEN** the file in `~/.ibmi-agent-kit` is used

### Requirement: A server name must exactly match a listed profile
A `server` argument SHALL be accepted only if it equals, case-sensitively, a name `list_servers`
reports. Any other value SHALL be refused before any file is read, with the available names in
the error.

#### Scenario: Path traversal refused
- **WHEN** a tool is called with `server: "x/../.env.prod"`
- **THEN** the call fails naming the available servers, and no file outside the listed profiles is read

#### Scenario: Case mismatch refused
- **WHEN** profile `prod` exists and a tool is called with `server: "PROD"`
- **THEN** the call fails, including on case-insensitive file systems

#### Scenario: Omitted server
- **WHEN** a tool is called without `server`
- **THEN** the `default` profile is used, and the call fails naming the available servers if none exists

### Requirement: One file supplies a whole profile
A profile SHALL be read from exactly one file. Values SHALL NOT be merged from other profile
files or folders. Process environment variables MAY fill settings the file omits, except
`IBMI_HOST`, `IBMI_USER` and `IBMI_PASSWORD`, which come from the file only; a value in the file
always wins over the environment.

#### Scenario: No password inheritance
- **WHEN** `~/.ibmi-agent-kit/.env.dev` has a host and user but no password, and another file has a password
- **THEN** loading `dev` fails naming the missing `IBMI_PASSWORD`

#### Scenario: Environment does not leak in
- **WHEN** `IBMI_PASSWORD` is set in the process environment and `.env.dev` omits it
- **THEN** loading `dev` fails naming the missing `IBMI_PASSWORD`

#### Scenario: File beats environment
- **WHEN** `.env.dev` sets `IBMI_READ_ONLY=true` and the process environment sets `IBMI_READ_ONLY=false`
- **THEN** the `dev` profile is read-only

### Requirement: Both engines read the same profiles
The screen engine and the source engine SHALL resolve every server name through the same loader,
so the same name selects the same file for 5250 and SQL work.

#### Scenario: Same file for both
- **WHEN** `session_open` and `run_sql` are both called with `server: pub400`
- **THEN** both read the same `.env.pub400` file
