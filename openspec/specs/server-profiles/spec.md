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

### Requirement: setup writes a profile from a terminal
`ibmi-agent-kit setup [name]` SHALL ask for host and user (offering an existing file's values as
defaults), read the password without echo, optionally take a policy path stored as an absolute
path, and write `.env` (name `default`, the default) or `.env.<name>` in the first profile folder,
creating the folder. An existing file SHALL keep all its other lines and comments.

#### Scenario: New profile
- **WHEN** `setup demo` runs in a terminal with no `.env.demo` in the first profile folder
- **THEN** it writes `.env.demo` there with `IBMI_HOST`, `IBMI_USER` and `IBMI_PASSWORD`

#### Scenario: Update keeps other lines
- **WHEN** `.env.demo` has comments and other settings and `setup demo` changes the user
- **THEN** the comments and other settings are unchanged and the user is the new value

#### Scenario: Policy path made absolute
- **WHEN** the policy answer is a relative path
- **THEN** `IBMI_KIT_POLICY` is written as that path resolved to an absolute one

### Requirement: setup refuses what it cannot write safely
`setup` SHALL refuse, writing nothing, when the name breaks the profile file rules or contains
characters other than letters, digits, `.`, `_` and `-`, when stdin is not a terminal, when the
user presses Ctrl-C, or when a value would not read back identical through the profile loader.

#### Scenario: Bad names
- **WHEN** the name is `example`, ends `.bak`, or contains `/`, `\` or `..`
- **THEN** `setup` exits non-zero and writes no file

#### Scenario: Not a terminal
- **WHEN** stdin is a pipe
- **THEN** `setup` exits non-zero telling the user to run it in a terminal, and echoes nothing

#### Scenario: Hostile password round-trips
- **WHEN** the password holds `#`, `=`, spaces, `$`, `'` and `"`
- **THEN** loading the written profile returns the identical password

### Requirement: setup writes atomically and privately
`setup` SHALL write through a temporary file in the same folder renamed over the target, and on
POSIX the profile file SHALL have mode 0600.

#### Scenario: File mode
- **WHEN** `setup` writes a profile on Linux or macOS
- **THEN** the file's mode is 0600

### Requirement: setup tests the written profile
After writing, `setup` SHALL load the profile back from the file through the profile loader, confirm
the name is listed, connect with the profile's SQL transport, run
`SELECT CURRENT USER, CURRENT SERVER FROM SYSIBM.SYSDUMMY1`, and print one line saying OK or failed
with the reason; a failure exits non-zero and leaves the file written.

#### Scenario: Connection fails
- **WHEN** the connection is refused
- **THEN** `setup` prints one failed line with the reason and exits non-zero

### Requirement: setup never reveals the password
The password SHALL NOT be taken from argv and SHALL NOT appear in anything `setup` prints, including
connection error text, which SHALL have the password removed before printing.

#### Scenario: Error text names the password
- **WHEN** the transport's error message contains the password
- **THEN** the printed line does not contain it

### Requirement: setup recognises a company config repo
When the current folder holds a `policy.yaml` file and a `profiles/` folder, `setup` SHALL run in
company-repo mode. The partitions are the profile names of the `profiles/.env.<partition>` files,
by the loader's file rules. Folders above the current one SHALL NOT be searched.

#### Scenario: Partitions offered
- **WHEN** `setup` runs with no name in a folder holding `policy.yaml` and `profiles/.env.dev`,
  `profiles/.env.prod` and `profiles/.env.example`
- **THEN** it offers `dev` and `prod` to choose from, and writes the profile named after the choice

#### Scenario: One partition
- **WHEN** the repo holds a single skeleton
- **THEN** `setup` uses it without asking which

#### Scenario: Unknown name
- **WHEN** `setup qa` runs in a company repo with no `profiles/.env.qa`
- **THEN** it exits non-zero naming the partitions found and writes nothing

#### Scenario: Not a company repo
- **WHEN** the current folder lacks `policy.yaml` or `profiles/`
- **THEN** `setup` asks for host, user, password and policy as it does outside a repo

### Requirement: setup takes the company's settings from the repo
In company-repo mode `setup` SHALL copy every setting of the chosen skeleton into the profile except
`IBMI_USER`, `IBMI_PASSWORD` and `IBMI_KIT_POLICY`, SHALL write `IBMI_KIT_POLICY` as the absolute
path of the repo's `policy.yaml`, and SHALL ask only the user and the hidden password. A skeleton
without `IBMI_HOST` or `IBMI_PARTITION`, or a policy that does not load, SHALL be refused with
nothing written.

#### Scenario: Other skeleton settings copied
- **WHEN** `profiles/.env.dev` holds `IBMI_SQL_TRANSPORT=mapepire` and `IBMI_KIT_POLICY=/admin/policy.yaml`
- **THEN** the profile `dev` holds `IBMI_SQL_TRANSPORT=mapepire`, the connection test uses it, and
  its `IBMI_KIT_POLICY` is the clone's `policy.yaml`, not the skeleton's path

#### Scenario: Policy path written
- **WHEN** a colleague runs `setup dev` in a clone at any folder
- **THEN** the profile `dev` holds the skeleton's host and partition and `IBMI_KIT_POLICY` set to
  that clone's `policy.yaml` as an absolute path, and the connection test runs as before

#### Scenario: Placeholder user not offered
- **WHEN** the skeleton's `IBMI_USER` is `YOUR_USER` and no profile `dev` exists yet
- **THEN** the user prompt offers no default

#### Scenario: Policy path replaced
- **WHEN** the existing profile `dev` names a different `IBMI_KIT_POLICY`
- **THEN** `setup` says it replaces that path and writes the repo's

#### Scenario: Host replaced
- **WHEN** the existing profile `dev` holds a password for an `IBMI_HOST` other than the skeleton's
- **THEN** `setup` prints the skeleton's partition and host and that it replaces the old host,
  asks for a password without offering to keep the current one, and neither writes nor sends the
  old password to the new host

### Requirement: setup never puts a password in the company repo
In company-repo mode `setup` SHALL NOT write any file inside the repo, SHALL refuse to run when the
first profile folder, or a partition's profile file in it, resolves to a path inside the repo
(symlinks followed, the repo folder recognised under any spelling), and SHALL ignore a skeleton's `IBMI_PASSWORD` with a
warning naming the file.

#### Scenario: Repo unchanged
- **WHEN** `setup` completes in a company repo
- **THEN** every file in the repo is byte-identical to before and none contains the password

#### Scenario: Profile folder inside the repo
- **WHEN** `IBMI_KIT_CONFIG_DIR` points at a folder inside the repo
- **THEN** `setup` exits non-zero before the first prompt and writes nothing

#### Scenario: Profile folder linked into the repo
- **WHEN** `IBMI_KIT_CONFIG_DIR` points at a folder outside the repo that is a symlink or junction
  to a folder inside it
- **THEN** `setup` exits non-zero before the first prompt and writes nothing

#### Scenario: Skeleton holds a password
- **WHEN** `profiles/.env.dev` contains `IBMI_PASSWORD=x`
- **THEN** `setup` warns that the file holds a password and to remove it from the repo, never
  writes `x` to the profile, and asks for the password as usual

### Requirement: setup points at the kit for the repo's server registration
In company-repo mode, when the repo's `.mcp.json` refers to `${IBMI_KIT_HOME}` and that variable is
not set, `setup` SHALL print the kit folder it runs from as the value to give `IBMI_KIT_HOME`. It
SHALL NOT set the variable itself.

#### Scenario: Variable unset
- **WHEN** `setup` runs in a company repo whose `.mcp.json` uses `${IBMI_KIT_HOME}`, without that
  variable in its environment
- **THEN** its output names the kit folder to set `IBMI_KIT_HOME` to

#### Scenario: Registration without the variable
- **WHEN** the repo's `.mcp.json` does not mention `IBMI_KIT_HOME`
- **THEN** `setup` prints no such hint
