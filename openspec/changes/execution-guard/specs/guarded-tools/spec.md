# Spec Delta

## Purpose

Puts the execution policy in front of every kit tool that changes or runs something on IBM i,
and gives agents a way to run scripts and to ask what the policy would decide.

## ADDED Requirements

### Requirement: run_script checks every statement before running any
`run_script` SHALL take a script of SQL statements and `CL:` commands and a `server`. It SHALL
classify and decide every statement first; if any is denied, nothing SHALL be sent. Allowed
statements SHALL run in order, stopping at the first failure, and the result SHALL give each
statement's decision, outcome, rows affected or returned (bounded), and messages.

#### Scenario: One denied statement
- **WHEN** a three-statement script's third statement is denied
- **THEN** no statement runs, and the result names the denied statement and the rule or reason

#### Scenario: Failure stops the script
- **WHEN** the second of three allowed statements fails on the IBM i
- **THEN** the third is not sent, and the result shows the first succeeded and the second's error

### Requirement: policy_check decides without running
`policy_check` SHALL take a script and a `server` and return, for each statement, its classified
operations with library, environment and class, the matching rule, and the decision, without
sending any statement to run. It SHALL be annotated read-only.

#### Scenario: Explain a decision
- **WHEN** `policy_check` is given `DELETE FROM INLIB1.ORD WHERE K = 1`
- **THEN** it returns `write INLIB1.ORD`, the environment, the matching rule, and the decision

### Requirement: Existing tools are decided before they act
Before acting, `run_sql` SHALL be decided as reads of its objects; `upload_source_member` as a
`write` to the member's library; `compile_member` as `compile` into its target library, and for
an SQL-type member also as every statement in the member; CL typed by `screen_do` into a command
line as that command. A denied call SHALL fail without contacting the IBM i for the action.

#### Scenario: Compile of an SQL member
- **WHEN** `compile_member` is called for a member of type SQL that contains `DROP TABLE B.X`
- **THEN** it is decided as `compile` plus `ddl B.X`, and denied if either is denied

#### Scenario: Command line on a screen
- **WHEN** `screen_do` types `CLRPFM FILE(B/X)` into a command line and the policy denies it
- **THEN** nothing is typed and the result gives the reason

### Requirement: The engines' own checks still apply
The policy SHALL be an additional check: `run_sql` stays select-only, screen restricted mode and
the compile command checks stay in force. An operation SHALL run only if both the policy and the
engine's own check allow it.

#### Scenario: Policy allows, engine refuses
- **WHEN** the policy allows a command that screen restricted mode refuses
- **THEN** the command is not typed and the result names restricted mode

### Requirement: Confirm asks the user, never the agent
A `confirm` decision SHALL ask the user through MCP elicitation, showing the server, partition,
statement and its classified operations; only an explicit accept runs it, and only that
statement. A client without elicitation support, a decline, a cancel or a timeout SHALL be
treated as deny. No tool input SHALL be able to pre-approve a confirmation.

#### Scenario: Client without elicitation
- **WHEN** a statement needs confirmation and the client does not support elicitation
- **THEN** it is denied with a message saying confirmation is unavailable in this client

#### Scenario: User accepts
- **WHEN** the user accepts the confirmation
- **THEN** that statement runs and the run log records the confirmation

### Requirement: Limits are stated where users see them
`policy_check` results, deny messages and the README SHALL state that the guard classifies the
text it is given and does not see what called programs, triggers, menu options or prompted 5250
fields do, and that IBM i authority remains the real boundary. Deny messages SHALL tell the agent
not to look for another route to the same action.

#### Scenario: Deny message
- **WHEN** any statement is denied
- **THEN** the message names the reason and tells the agent to ask the user instead of retrying another way
