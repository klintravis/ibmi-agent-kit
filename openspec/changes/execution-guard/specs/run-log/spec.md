# Spec Delta

## Purpose

Keeps a local record of what the guard decided and what ran, so a team can see what was blocked,
what was wrongly blocked and what was confirmed while tuning its policy.

## ADDED Requirements

### Requirement: Every decision is recorded
For every guarded call the kit SHALL append one JSON line per statement to a daily file in
`<config dir>/runs/`, recording time, IBM i user, role, server, partition, policy file hash,
tool, statement text, classified operations, matching rule, decision, whether it was confirmed,
and outcome.

#### Scenario: Denied statement logged
- **WHEN** a statement is denied
- **THEN** the day's run file gains a line with decision `deny`, the rule or reason, and no outcome

#### Scenario: Confirmed statement logged
- **WHEN** the user accepts a confirmation and the statement succeeds
- **THEN** the line records `confirmed: true` and the outcome

### Requirement: The log never holds credentials
Run log lines SHALL NOT contain passwords or other profile secrets.

#### Scenario: Profile values excluded
- **WHEN** any call is logged
- **THEN** no line contains the profile's `IBMI_PASSWORD` value

### Requirement: A logging failure does not block work
If the run log cannot be written, the kit SHALL report it once on standard error and continue;
it SHALL NOT change any decision.

#### Scenario: Read-only folder
- **WHEN** the runs folder is not writable
- **THEN** guarded calls still run as decided and one warning is printed

### Requirement: It is described as a run log, not an audit trail
Documentation SHALL describe the log as a local run log that the user can edit, not as an audit
trail.

#### Scenario: README wording
- **WHEN** the README describes the log
- **THEN** it calls it a run log and says it is not tamper-proof
