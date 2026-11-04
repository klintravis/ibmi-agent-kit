## ADDED Requirements

### Requirement: note action
`screen_do` and `run_tests` SHALL accept `note: <text>` as an action line. A note SHALL attach to the next `key:` action in the same batch and SHALL appear in that step's label as `<key>: <note>`. A note SHALL NOT be sent to the host or the execution guard. A note with no key after it in the batch, or an empty note, SHALL be rejected before any action is sent to the host.

#### Scenario: Note labels the next key
- **WHEN** a batch is `["note: open the list", "key: F4"]`
- **THEN** the step label is `F4: open the list` and only F4 reaches the host

#### Scenario: Trailing note rejected
- **WHEN** a batch is `["key: Enter", "note: why"]`
- **THEN** the call fails and nothing is sent, not even the Enter

#### Scenario: Empty note rejected
- **WHEN** an action line is `note:` with no text
- **THEN** the call fails and nothing is sent

### Requirement: Run report
When the profile sets `IBMI_5250_REPORT_DIR`, each session SHALL write one self-contained HTML file in that folder, with no script and no external resource, holding for each step its number, local time, label and the screen. The folder SHALL be created if missing. With the setting unset nothing SHALL be written.

#### Scenario: Report holds each step
- **WHEN** a session presses two keys with the setting set
- **THEN** the file holds both labels and both screens

#### Scenario: Setting unset
- **WHEN** `IBMI_5250_REPORT_DIR` is not in the profile
- **THEN** no file is written and behaviour is unchanged

### Requirement: Report survives a crash
Each step SHALL be appended to the file as it happens, so a run that stops mid-way leaves a readable report up to the last step. The server SHALL NOT hold the screens in memory.

#### Scenario: File without a closing tag
- **WHEN** the server is killed after the second step
- **THEN** the file holds both steps

### Requirement: Report safety
The report file name SHALL be built from a UTC timestamp and the server and session names reduced to `[A-Za-z0-9_-]`, and an existing file SHALL NOT be overwritten. The file SHALL have mode 0600 on POSIX. A folder inside a git work tree SHALL be refused. Every label, note, test name, failure message and name SHALL be HTML-escaped, and the value of a hidden field SHALL NOT appear. A refusal or any write failure SHALL log a warning and the session SHALL continue.

#### Scenario: Session name with a path
- **WHEN** the session is named `../../x`
- **THEN** the file is created inside the report folder

#### Scenario: Escaped label
- **WHEN** a note contains `<script>`
- **THEN** the file contains no `<script` tag

#### Scenario: Work tree refused
- **WHEN** the folder is inside a git work tree
- **THEN** no file is written, a warning is logged and the session runs

#### Scenario: Unwritable folder
- **WHEN** the folder cannot be created or written
- **THEN** a warning is logged and the session runs

### Requirement: Test results in the report
For `run_tests`, the report SHALL record each test's name, whether it passed, and the message of each failed check, as a block after that test's steps.

#### Scenario: Failing test recorded
- **WHEN** a test fails an expectation
- **THEN** the report holds the test name, FAIL and the check message

### Requirement: Report path in results
`session_open` and `session_close` results SHALL name the report file when one is being written.

#### Scenario: Path named
- **WHEN** a session with a report opens and closes
- **THEN** both results contain the report path
