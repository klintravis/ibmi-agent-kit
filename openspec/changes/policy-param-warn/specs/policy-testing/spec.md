# Spec Delta

## ADDED Requirements

### Requirement: Policy test prints undeclared parameter warnings
`ibmi-agent-kit policy test` SHALL print on stderr each undeclared-parameter warning of every case,
passing or failing, with the case name, and SHALL include them in a failing case's report. The
warnings SHALL NOT change any case's result or the exit code.

#### Scenario: Passing case with an undeclared keyword
- **WHEN** a case runs `CL: XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)`, the `XYZCPY` entry does
  not name `TOLIB`, and the case's `expect` matches
- **THEN** stderr has a warning naming the case, `XYZCPY` and `TOLIB`, the case passes, and the
  command exits 0 when every case passes

#### Scenario: Declared keywords only
- **WHEN** every case uses only parameters the command table entries name
- **THEN** no warning is printed and the output is as before
