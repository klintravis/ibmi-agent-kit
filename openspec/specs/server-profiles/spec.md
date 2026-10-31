# server-profiles Specification

## Purpose
Defines how the kit finds and loads the named IBM i server profiles a user signs on with, so a
server name always means one file and one box, and no file's settings leak into another's.

## Requirements

### Requirement: Profiles are searched in a fixed order of folders
Profiles SHALL be searched in `IBMI_KIT_CONFIG_DIR` (or, when unset, `IBMI_MCP_CONFIG_DIR`), then
`~/.ibmi-agent-kit`, then `~/.ibm-i-servers`. A file named `.env` is the `default` server and
`.env.<name>` is server `<name>`; `.env.example`, `.env.default`, `.env.` and names ending `.bak`,
`.orig` or `~` are never servers, and only regular files are. No other folder is read.

#### Scenario: Shared folder fallback
- **WHEN** only `~/.ibm-i-servers/.env.pub400` exists
- **THEN** `list_servers` includes `pub400` and tools accept `server: pub400`

#### Scenario: Earlier folder wins
- **WHEN** `.env.pub400` exists in both `~/.ibmi-agent-kit` and `~/.ibm-i-servers`
- **THEN** the file in `~/.ibmi-agent-kit` is used

#### Scenario: Old per-engine folder ignored
- **WHEN** a profile exists only in `~/.ibm-i-5250-mcp`
- **THEN** it is not listed, and the README migration notes say where to move it

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
A profile SHALL be read from exactly one file and SHALL NOT take values from other profile files.
Loading profiles SHALL NOT change the process environment.

#### Scenario: No password inheritance
- **WHEN** `.env.dev` has a host and user but no password, and another profile file has a password
- **THEN** loading `dev` fails naming the missing `IBMI_PASSWORD`

#### Scenario: Default file does not leak
- **WHEN** `.env` sets `IBMI_RESTRICTED=false` and `.env.prod` does not set it
- **THEN** the `prod` profile uses the engine default (restricted on), not `false`

### Requirement: Connection and safety settings come from the file only
Settings that select the box, the credentials, the transport or any guard (host, user, password,
ports, transport, restricted mode, allowed and blocked commands and tables, read-only) SHALL be
read only from the profile file. Other settings MAY fall back to the process environment when
the file omits them.

#### Scenario: Environment cannot lift a guard
- **WHEN** the process environment sets `IBMI_RESTRICTED=false` and `.env.dev` does not set it
- **THEN** the `dev` profile has restricted mode on

#### Scenario: Viewer setting from the registration
- **WHEN** the process environment sets `IBMI_5250_VIEWER=true` and `.env.dev` does not set it
- **THEN** the `dev` profile has the viewer enabled

### Requirement: Both engines read the same profiles
The screen engine and the source engine SHALL resolve every server name through the same loader.

#### Scenario: Same file for both
- **WHEN** `session_open` and `run_sql` are both called with `server: pub400`
- **THEN** both read the same `.env.pub400` file
