# Spec Delta

## ADDED Requirements

### Requirement: Undeclared parameter warnings are logged
The run log SHALL record each undeclared-parameter warning of a guarded call in that call's notes
(on its first line, as other notes are), so a team reviewing the log sees commands whose libraries
were not decided. The line format SHALL NOT change.

#### Scenario: Run with an undeclared keyword
- **WHEN** `run_script` decides `CL: XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)` and the `XYZCPY`
  entry does not name `TOLIB`
- **THEN** the call's first run log line has a note naming `XYZCPY` and `TOLIB`
