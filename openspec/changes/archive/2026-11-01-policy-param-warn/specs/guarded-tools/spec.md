# Spec Delta

## ADDED Requirements

### Requirement: policy_check shows undeclared parameter warnings
`policy_check` SHALL return, for each statement that has them, the undeclared-parameter warnings
from classification, in its structured output (a `warnings` list on the statement) and as a line
per warning in its text, for a script and for a verb, live and offline (`as`). It SHALL stay
annotated read-only and its decisions SHALL be unchanged.

#### Scenario: Undeclared keyword
- **WHEN** `policy_check` is given `CL: XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)` and the table
  entry for `XYZCPY` does not name `TOLIB`
- **THEN** the statement's `warnings` names `XYZCPY` and `TOLIB`, the text shows the warning, and
  the decision is the one made for `APPLIB/ORD` alone

#### Scenario: Declared keywords only
- **WHEN** `policy_check` is given a script whose commands use only parameters their entries name
- **THEN** no statement has `warnings` and the text has no warning line
