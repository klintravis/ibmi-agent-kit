# Spec Delta

## ADDED Requirements

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
