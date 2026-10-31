# Spec Delta

## Purpose

Puts the execution policy in front of every kit entry point that reads, changes or runs something
on IBM i, and gives agents a way to run scripts and to ask what the policy would decide.

## ADDED Requirements

### Requirement: run_script decides and confirms everything before running anything
`run_script` SHALL take a script of SQL statements and `CL:` commands and a `server`, classify and
decide every statement, and ask one confirmation covering every `confirm` operation, before
sending any statement. Any deny or a declined confirmation SHALL send nothing. Statements SHALL run
in order, stopping at the first failure, returning per statement its decision, outcome, rows
affected, up to `maxRows` (default 100, at most 1000) rows returned, and messages.

#### Scenario: One denied statement
- **WHEN** a three-statement script's third statement is denied
- **THEN** no statement runs, and the result names the denied statement and the rule or reason

#### Scenario: Declined confirmation
- **WHEN** statements 1 and 3 need confirmation and the user declines
- **THEN** no statement runs

#### Scenario: Failure stops the script
- **WHEN** the second of three allowed statements fails on the IBM i
- **THEN** the third is not sent, and the result shows the first succeeded and the second's error

### Requirement: run_script respects the profile's own guards
`run_script` SHALL refuse writes, DDL, compiles, calls and CL on a profile with `IBMI_READ_ONLY`,
and SHALL refuse any statement touching a table in `IBMI_BLOCKED_TABLES`, in addition to the policy.

#### Scenario: Read-only profile
- **WHEN** `run_script` sends an `UPDATE` on a read-only profile that the policy allows
- **THEN** it is refused naming `IBMI_READ_ONLY`

### Requirement: policy_check decides without running
`policy_check` SHALL take a script (or, after `project-verbs`, a verb and arguments) and a
`server`, and return per statement the classified operations with library, partition,
environment and class, the matching rule, and the decision, sending only the lookups needed to
decide. It SHALL be annotated read-only.

#### Scenario: Explain a decision
- **WHEN** `policy_check` is given `DELETE FROM INLIB1.ORD WHERE K = 1`
- **THEN** it returns `write INLIB1.ORD`, its environment, the matching rule and the decision

### Requirement: Existing tools are decided before they act
Before acting: `run_sql`, `read_source_member` and `search_source` SHALL be decided as reads of
their objects or library; `upload_source_member` as `write` to the member's library;
`manage_library_list` changes as `liblist` on each library; `compile_member` from its final command
string, plus the member's statements when the member type is SQL or the command is `RUNSQLSTM`, read
at decision time. A denied call SHALL fail without the action reaching the IBM i.

#### Scenario: Override target
- **WHEN** `compile_member` is called with `targetLibrary: JDOE` and `command: "CRTBNDRPG PGM(LIVLIB/ORDVAL) …"`
- **THEN** it is decided as `compile` into `LIVLIB`

#### Scenario: Blocked library source read
- **WHEN** `read_source_member` targets a library in an environment the rules deny for `read`
- **THEN** it fails and nothing is downloaded

### Requirement: 5250 command lines are decided when sent
Before the screen engine sends an AID key while the cursor's screen has a command line holding
text, that text SHALL be decided as a CL command, so retrieved (F9) and edited commands are
covered. `session_open` SHALL decide its `program` as `call` and its `library` as `liblist`.
Keystrokes the engine sends itself (sign-on, recovery, sign-off) SHALL NOT be decided.

#### Scenario: Retrieved command
- **WHEN** `screen_do` presses F9 then Enter, and the retrieved command is denied
- **THEN** Enter is not sent and the result gives the reason

#### Scenario: Sign-on program
- **WHEN** `session_open` is given `program: LIVLIB/ORDFIX` and the rules deny that call
- **THEN** sign-on does not proceed and the result gives the reason

### Requirement: The engines' own checks still apply
An operation SHALL run only if both the policy and the engine's own check allow it.

#### Scenario: Policy allows, engine refuses
- **WHEN** the policy allows a command that screen restricted mode refuses
- **THEN** the command is not sent and the result names restricted mode

### Requirement: Confirm asks the user, never the agent
A confirmation SHALL be an MCP elicitation showing the server, partition, and each operation
(class, object, environment) before the comment-stripped statement text; it runs only on
`action: accept` with `confirm: true`. Missing elicitation support, decline, cancel, or no answer
within 120 seconds SHALL deny. No tool input SHALL pre-approve.

#### Scenario: Client without elicitation
- **WHEN** confirmation is needed and the client lacks elicitation
- **THEN** it is denied with a message saying confirmation is unavailable in this client, and in
  observe mode the run log records it as a would-be confirmation

#### Scenario: Accepted with false
- **WHEN** the client answers `accept` with `confirm: false`
- **THEN** it is denied

#### Scenario: Startup notice
- **WHEN** the server connects to a client
- **THEN** it logs to stderr whether confirmation is available

### Requirement: Limits are stated where users see them
Deny messages, `policy_check` output and the README SHALL state that the guard classifies the text
it is given, does not see what called programs, triggers, application menu options or prompted
fields do, and that IBM i authority remains the real boundary. Deny messages SHALL tell the agent to
ask the user rather than try another route. The README SHALL recommend client permission rules that
stop the agent editing the policy file, profile files and verb folders.

#### Scenario: Deny message
- **WHEN** any operation is denied
- **THEN** the message names the reason and tells the agent to ask the user instead of retrying another way
