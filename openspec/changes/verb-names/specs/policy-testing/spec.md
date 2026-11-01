## MODIFIED Requirements

### Requirement: Policy test files state expected decisions
A policy test file SHALL be a YAML list of cases, each with `as` (identity), `script` (or `verb`
and `args`), optional `lookups`, and `expect` (`allow`, `confirm` or `deny`, overall or per
statement). `ibmi-agent-kit policy test <policy> <tests>` SHALL run every case, print each
mismatch with the operations, matching rule and actual decision, and exit non-zero if any case
fails. It SHALL also load the verbs of the project folder and beside the policy file whether or
not a case names a verb, print each refusal, and exit non-zero when any verb file is refused. A
policy with no verb folders SHALL behave as before.

#### Scenario: Passing suite
- **WHEN** every case's decision matches its `expect` and no verb file is refused
- **THEN** the command prints the count and exits 0

#### Scenario: Regression
- **WHEN** a policy edit makes a case that expected `deny` now `allow`
- **THEN** the command names the case, the rule that now matches, and exits non-zero

#### Scenario: Refused verb, no verb case
- **WHEN** a verb file beside the policy is refused at load and no test case names a verb
- **THEN** the command prints the refusal, still runs every case, and exits 1

#### Scenario: No verb folders
- **WHEN** neither verb folder exists
- **THEN** the command behaves as before
