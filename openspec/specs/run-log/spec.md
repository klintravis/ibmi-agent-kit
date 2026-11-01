# run-log Specification

## Purpose
Keeps a local record of what the guard decided and what ran, so a team can see what was blocked,
what was wrongly blocked and what was confirmed while tuning its policy.

## Requirements

### Requirement: Every decision is recorded
For every guarded operation the kit SHALL append one JSON line per statement to a daily file in
`<first config dir>/runs/`, recording time, IBM i user, role, server, partition, policy hash and
mode, tool, redacted statement text, operations, matching rule, decision, whether it was enforced,
whether it was confirmed, and outcome.

#### Scenario: Observed deny
- **WHEN** in observe mode a statement would be denied
- **THEN** the line records `decision: deny`, `enforced: false` and the outcome

#### Scenario: Confirmed statement
- **WHEN** the user accepts a confirmation and the statement succeeds
- **THEN** the line records `confirmed: true` and the outcome

### Requirement: The log never holds secrets
Run log lines SHALL NOT contain the profile password, and statement text SHALL have the values of
password-bearing CL parameters (`PASSWORD`, `PWD`, `PWRDVPWD`, `NEWPWD`) and SQL `IDENTIFIED BY`,
`SET ENCRYPTION PASSWORD` and `PASSWORD =` clauses replaced with `***`.

#### Scenario: Password in a command
- **WHEN** `run_script` runs `CL: CHGUSRPRF USRPRF(X) PASSWORD(SECRET1)`
- **THEN** the logged text reads `PASSWORD(***)`

### Requirement: A logging failure does not block work
If the run log cannot be written, the kit SHALL warn once on standard error and continue without
changing any decision.

#### Scenario: Read-only folder
- **WHEN** the runs folder is not writable
- **THEN** guarded operations still run as decided and one warning is printed

### Requirement: It is described as a run log, not an audit trail
Documentation SHALL describe the log as a local run log the user can edit, not an audit trail.

#### Scenario: README wording
- **WHEN** the README describes the log
- **THEN** it calls it a run log and says it is not tamper-proof

### Requirement: Undeclared parameter warnings are logged
The run log SHALL record each undeclared-parameter warning of a guarded call in that call's notes
(on its first line, as other notes are), so a team reviewing the log sees commands whose libraries
were not decided. The line format SHALL NOT change.

#### Scenario: Run with an undeclared keyword
- **WHEN** `run_script` decides `CL: XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)` and the `XYZCPY`
  entry does not name `TOLIB`
- **THEN** the call's first run log line has a note naming `XYZCPY` and `TOLIB`
