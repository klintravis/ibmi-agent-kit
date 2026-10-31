## ADDED Requirements

### Requirement: Quiet check output
Each package's `check` script SHALL run its self-check with the `dot` test reporter, so a passing
run prints one character per test and a failing run prints each failed test's name and assertion
message. The packages SHALL declare `engines.node` of `>=20`.

#### Scenario: All tests pass
- **WHEN** `npm run check` passes
- **THEN** the test output is dots only and the exit code is 0

#### Scenario: A test fails
- **WHEN** a self-check assertion fails
- **THEN** the output lists the test name and the assertion message and the exit code is non-zero
