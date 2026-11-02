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
- **WHEN** `.env.dev` has a host and user but no password source, and another profile file has a password
- **THEN** loading `dev` fails naming the missing `IBMI_PASSWORD_STORE` or `IBMI_PASSWORD_COMMAND`

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
defaults), ask for the password source, read any password without echo, optionally take a policy path
stored as an absolute path, and write `.env` (name `default`, the default) or `.env.<name>` in the first
profile folder, creating the folder. An existing file SHALL keep all its other lines and comments.

#### Scenario: New profile
- **WHEN** `setup demo` runs in a terminal with no `.env.demo` in the first profile folder
- **THEN** it writes `.env.demo` there with `IBMI_HOST`, `IBMI_USER` and the chosen password source

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

#### Scenario: Hostile helper command round-trips
- **WHEN** the helper command starts with a double-quoted path and holds `#`, `=`, spaces, `$` and a
  backslash followed by `n`
- **THEN** loading the written profile returns the identical command

#### Scenario: Hostile password round-trips
- **WHEN** the password holds `#`, `=`, spaces, `$`, `'` and `"`
- **THEN** the store holds the identical password and the file does not contain it

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
connection error text, which SHALL have the password removed before printing, whether it was typed or
returned by a helper or the store.

#### Scenario: Error text names the password
- **WHEN** the transport's error message contains the password
- **THEN** the printed line does not contain it

#### Scenario: Error text names a helper's password
- **WHEN** the transport's error message contains what the helper returned
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
`IBMI_USER`, `IBMI_PASSWORD`, `IBMI_PASSWORD_COMMAND`, `IBMI_PASSWORD_STORE` and `IBMI_KIT_POLICY`,
SHALL write `IBMI_KIT_POLICY` as the absolute path of the repo's `policy.yaml`, and SHALL ask only the
user and the password source. A skeleton without `IBMI_HOST` or `IBMI_PARTITION`, or a policy that does
not load, SHALL be refused with nothing written.

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
- **WHEN** the existing profile `dev` holds a password or helper for an `IBMI_HOST` other than the
  skeleton's
- **THEN** `setup` prints the skeleton's partition and host and that it replaces the old host,
  asks for the password source without offering to keep the current one, and neither writes nor sends
  the old password to the new host

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

### Requirement: setup keeps a password only for the same host
In personal and company-repo mode alike, `setup` SHALL offer to keep the profile's current password,
store entry or helper (Enter at the prompt) only when the host and user the profile will hold equal its
current `IBMI_HOST` and `IBMI_USER`. Otherwise it SHALL ask with no default, SHALL say that the old host
is replaced when the profile had one, and SHALL neither write nor send the old password.

#### Scenario: Host changed
- **WHEN** `.env.prod` holds `IBMI_HOST=old.example.com` and a password, and `setup prod` outside a
  company repo gets `new.example.com` at the host prompt and Enter at the source prompt
- **THEN** `setup` says `old.example.com` is replaced by `new.example.com`, does not offer to keep
  the current password, asks for the password again, and the old password is neither written to
  `.env.prod` nor sent in the connection test

#### Scenario: Host unchanged
- **WHEN** `.env.prod` holds `IBMI_HOST=old.example.com` and a password, and `setup prod` gets
  Enter at the host, user, source and password prompts
- **THEN** `setup` offers to keep the current password and the store holds it for that user and host

#### Scenario: User changed
- **WHEN** `.env.prod` holds a password and `setup prod` gets the same host and a different user
- **THEN** `setup` asks for the password with no default

#### Scenario: Old profile has no host
- **WHEN** `.env.prod` holds a password but no `IBMI_HOST`
- **THEN** `setup prod` asks for the password with no default

#### Scenario: Current helper kept
- **WHEN** `.env.prod` holds `IBMI_PASSWORD_COMMAND` and `setup prod` gets the same host and user and
  Enter at the source prompt
- **THEN** the helper line is unchanged and it runs once for the test

### Requirement: A profile's password has one source
The password SHALL come from `IBMI_PASSWORD_COMMAND` when the profile sets it, else from the OS store
when the profile sets `IBMI_PASSWORD_STORE=os`, else from `IBMI_PASSWORD`. Both new keys SHALL be read
from the profile file only. Any other `IBMI_PASSWORD_STORE` value SHALL fail the load. When the chosen
source fails, the kit SHALL NOT fall back to another source.

#### Scenario: Helper wins over the store and the plain line
- **WHEN** `.env.dev` sets all three keys
- **THEN** the helper's output is sent, the store is not read, and a warning says the plain line is ignored

#### Scenario: No fallback
- **WHEN** `.env.dev` sets `IBMI_PASSWORD_COMMAND` and `IBMI_PASSWORD`, and the helper exits non-zero
- **THEN** the connection fails with the helper's error and the plain password is not sent

#### Scenario: Environment cannot choose a helper
- **WHEN** the process environment sets `IBMI_PASSWORD_COMMAND` and `.env.dev` does not
- **THEN** the helper is not run

### Requirement: A plain password line warns
A profile's `IBMI_PASSWORD` line SHALL keep working. When it is used or ignored, the kit SHALL warn once
per process on standard error, naming the file and not the value.

#### Scenario: Old profile keeps working
- **WHEN** `.env.dev` has only `IBMI_PASSWORD`
- **THEN** it connects as before and standard error carries the warning once

### Requirement: The password is fetched only for a send
Reading a profile SHALL NOT run a helper or read the OS store. A helper SHALL run, or the store be
read, exactly once for each attempt to send the password, and the fetched value SHALL NOT be reused for
a later send.

#### Scenario: Non-secret reads
- **WHEN** the policy path, the partition, a verb lookup or `list_servers` reads a helper profile
- **THEN** the helper is not run

#### Scenario: Once per connection
- **WHEN** one connection signs on
- **THEN** the helper runs exactly once

#### Scenario: Rotated password picked up
- **WHEN** the helper's output changes between two connections of one process
- **THEN** the second connection sends the new value

### Requirement: A helper command is split by one rule
`IBMI_PASSWORD_COMMAND` SHALL be split so that whitespace separates arguments outside double quotes, a
double quote toggles quoting and is removed, a backslash and a single quote are literal, and an
unterminated quote is an error. A first token ending `.cmd`, `.bat` or `.ps1` SHALL be refused before
running, with an error showing the `powershell -NoProfile -File <script>` form.

#### Scenario: Quoted Windows path
- **WHEN** the value is `"C:\Program Files\x\get.exe" -File "C:\new\y z.ps1"`
- **THEN** the executable is `C:\Program Files\x\get.exe` and its arguments are `-File` and `C:\new\y z.ps1`

#### Scenario: Batch file refused
- **WHEN** the value is `C:\tools\get.cmd`
- **THEN** nothing runs and the error shows the `powershell -NoProfile -File` form

### Requirement: A helper runs without a shell
The executable SHALL run with no shell, with the working directory set to the user's home folder, no
standard input, its standard error discarded, a 30 second timeout and at most 64 KiB of output. The
password SHALL be its standard output decoded as UTF-8, with a leading BOM and one trailing line ending
removed.

#### Scenario: Success and trailing newline
- **WHEN** the helper prints `s3cret` and a line ending
- **THEN** the password sent is `s3cret`

#### Scenario: Trailing spaces kept
- **WHEN** the helper prints `s3cret ` with a trailing space and no line ending
- **THEN** the password sent is `s3cret ` unchanged

#### Scenario: Planted executable in the project folder
- **WHEN** the server's working directory holds a `powershell.exe` and the value starts `powershell`
- **THEN** the planted file is not run

### Requirement: A failing helper reveals nothing and is not retried
Empty output, a non-zero exit, a timeout, too much output or a failed start SHALL be an error naming only
the executable and the exit code or reason, with no output and no arguments, and SHALL NOT be retried.
Nothing SHALL be sent.

#### Scenario: Failure text holds no secret
- **WHEN** the helper prints the password and exits 1, prints nothing and exits 0, or never exits
- **THEN** the connection fails, nothing is sent, and the error does not contain what it printed

### Requirement: A helper line in a git work tree is refused
At fetch time, the kit SHALL refuse `IBMI_PASSWORD_COMMAND` when the real path of the profile file has
a `.git` entry in its folder or any parent, with an error naming the file and pointing at
`IBMI_PASSWORD_STORE=os` or a folder outside the work tree. The path SHALL be recorded by the loader so
no profile line or environment value can set it. `IBMI_PASSWORD_STORE=os` SHALL work in a git work tree.

#### Scenario: Profile folder in a clone
- **WHEN** `IBMI_KIT_CONFIG_DIR` is inside a git clone whose `.env.dev` sets `IBMI_PASSWORD_COMMAND`
- **THEN** the helper does not run and the connection fails with that error

#### Scenario: Reading the profile still works
- **WHEN** the same profile is read for its partition
- **THEN** the read succeeds and no error is raised

#### Scenario: Location cannot be spoofed
- **WHEN** `.env.dev` in a git clone also sets `IBMI_KIT_PROFILE_FILE=/elsewhere/.env.dev`
- **THEN** the helper is still refused

### Requirement: The OS store holds a password per user and host
With `IBMI_PASSWORD_STORE=os`, the password SHALL be read from the OS credential store under service
`ibmi-agent-kit` and account `<USER>@<host>`, with the user upper-cased and the host lower-cased, in the
process and with no helper. On Linux the kit SHALL require the Secret Service and SHALL NOT fall back to
the kernel keyring. A missing entry, an unavailable store or a module that cannot load SHALL be an error
pointing at `ibmi-agent-kit credential set` or `IBMI_PASSWORD_COMMAND`.

#### Scenario: Host changed by hand
- **WHEN** a store entry exists for `DEV1@old.example.com` and the file's host becomes `new.example.com`
- **THEN** the connection fails naming the missing entry and the old password is not sent to the new host

#### Scenario: No Secret Service on Linux
- **WHEN** the machine has no Secret Service
- **THEN** storing and reading fail with a message pointing at `IBMI_PASSWORD_COMMAND`, and nothing is
  stored in the kernel keyring

### Requirement: credential manages the store entry of a profile
`ibmi-agent-kit credential set <profile>` SHALL read the password from a hidden prompt, or one line of
standard input when that is not a terminal, and store it for the profile's user and host.
`ibmi-agent-kit credential delete <profile>` SHALL remove that entry. The password SHALL NOT be taken
from argv. The kit SHALL NOT offer a command that prints a stored password. Usage errors and store
failures SHALL exit 2 and neither command SHALL change the profile file.

#### Scenario: Rotation
- **WHEN** `credential set dev` runs and a server already holds the profile open
- **THEN** the entry is replaced and the server's next sign-on sends the new password

#### Scenario: Password on the command line
- **WHEN** `credential set dev s3cret` runs
- **THEN** it exits 2 and stores nothing

### Requirement: A rejected password is not sent again
At every place the kit sends a password, a send the box rejects SHALL be recorded for that user and
host for the life of the process. The next attempt SHALL fetch the password once and, when it equals
the rejected one, SHALL fail without sending, with an error telling the user to change the password in
the store or helper, or restart the server to try the same one again. When it differs, it SHALL be sent,
and an accepted send SHALL clear the record.

#### Scenario: One guarded call sends once
- **WHEN** a guarded SQL tool call hits a wrong password, the identity lookup fails and the tool's own
  query then connects
- **THEN** the password is sent once and the second connection fails without sending

#### Scenario: Plain profile too
- **WHEN** a profile with only `IBMI_PASSWORD` is rejected
- **THEN** the next attempt fails without sending

#### Scenario: Per-suite sign-on
- **WHEN** `run_tests` runs three suites with a wrong password
- **THEN** the password is sent once

#### Scenario: Corrected password
- **WHEN** a send was rejected and the store entry then changes
- **THEN** the next attempt sends the new password with no restart

### Requirement: Sign-ons for one user and host run one at a time
The kit SHALL send at most one password at a time for a user and host, across both engines, so a second
sign-on sees the result of the first.

#### Scenario: Concurrent tools
- **WHEN** `run_sql` and `session_open` start together with a wrong password for one user and host
- **THEN** the password is sent once

### Requirement: Only an authentication failure counts as a rejection
A rejection SHALL mean an SSH `client-authentication` failure, a 5250 sign-on failure or the sign-on
screen still showing after Enter, or a mapepire daemon error showing `Unexpected server response: 401` or
authentication as a whole word (not as part of a host name such as `authentication-gw.corp`). Any
other failure SHALL NOT be recorded.

#### Scenario: Refused connection is not a rejection
- **WHEN** a connection fails because the host is unreachable
- **THEN** nothing is recorded and the next attempt sends the password

#### Scenario: Daemon rejects the password
- **WHEN** the daemon's WebSocket handshake fails with `Unexpected server response: 401`
- **THEN** the send is recorded as rejected

### Requirement: setup never writes a plain password
`setup` SHALL ask for the password source: Enter stores the password in the OS store through a hidden
prompt, and any other answer is a helper command. It SHALL NOT write `IBMI_PASSWORD`, and SHALL remove
an existing `IBMI_PASSWORD` line and the line of the source not chosen. The test SHALL send the password
once.

#### Scenario: Default store
- **WHEN** `setup demo` gets Enter at the source prompt and a password
- **THEN** the store holds it for the profile's user and host, and the file holds `IBMI_PASSWORD_STORE=os`
  and no password

#### Scenario: Helper chosen
- **WHEN** the answer is `powershell -NoProfile -File "C:\tools\get pw.ps1"`
- **THEN** the file holds that value reading back identical, the store is not written, and the helper
  runs once for the test

#### Scenario: Old profile migrated
- **WHEN** `.env.prod` holds `IBMI_PASSWORD`, and `setup prod` gets the same host and user and Enter at
  both prompts
- **THEN** the old password moves to the store, the line is gone and every other line is unchanged

### Requirement: setup refuses a password source it cannot use
`setup` SHALL store the password before writing the file. A store failure SHALL exit non-zero with nothing
written and point at `IBMI_PASSWORD_COMMAND`. A helper command that breaks the split or `.cmd` rule, or a
helper for a profile folder in a git work tree, SHALL be refused with nothing written.

#### Scenario: Store unavailable
- **WHEN** the store cannot be written
- **THEN** `setup` exits non-zero, the file is unchanged, and the message points at `IBMI_PASSWORD_COMMAND`

#### Scenario: Helper in a git work tree
- **WHEN** the first profile folder is in a git work tree and the answer is a helper command
- **THEN** `setup` exits non-zero with nothing written and points at the OS store

### Requirement: setup does not copy a password source from a company skeleton
In company-repo mode `setup` SHALL NOT copy `IBMI_PASSWORD_COMMAND` or `IBMI_PASSWORD_STORE` from a
skeleton, and SHALL warn naming the file when a skeleton holds `IBMI_PASSWORD_COMMAND`.

#### Scenario: Skeleton holds a helper
- **WHEN** `profiles/.env.dev` contains `IBMI_PASSWORD_COMMAND=evil.exe`
- **THEN** `setup` warns, never writes or runs `evil.exe`, and asks for the source as usual

### Requirement: The password never appears in output
A password from any source SHALL NOT appear in tool output, the run log, the 5250 viewer, error text or
`list_servers`. The run log SHALL mask the last password fetched for the connection's user and host
without fetching again.

#### Scenario: Run log masks a helper's password
- **WHEN** a statement logged after a sign-on holds the helper's password as a literal
- **THEN** the logged text holds `***` in its place and the helper ran only for the sign-on
