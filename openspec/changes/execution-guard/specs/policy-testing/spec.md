# Spec Delta

## Purpose

Lets a company test and evolve its policy like code — offline, in its own CI — and see what a
candidate policy would change before adopting it.

## ADDED Requirements

### Requirement: Decisions can be computed offline for a stated identity
The kit SHALL decide a script for a given policy file and a stated identity (user, groups,
authorization lists, partition, current library) without connecting to an IBM i, using stated
answers for lookups (alias base tables, long-to-system schema names) where a case needs them.

#### Scenario: Offline decision
- **WHEN** a script is decided offline as user `JDOE` in group `GRPDEV` on partition `dev`
- **THEN** the result matches what the same policy decides for that identity on a live connection

### Requirement: Policy test files state expected decisions
A policy test file SHALL be a YAML list of cases, each with `as` (identity), `script` (or `verb`
and `args`), optional `lookups`, and `expect` (`allow`, `confirm` or `deny`, overall or per
statement). A verb case SHALL decide every statement the verb would send, nested verbs and
cleanup included, with the verb found in `.ibmi-kit/verbs/` in the working directory or `verbs/`
beside the policy file; a person's own verbs SHALL NOT be read. `ibmi-agent-kit policy test
<policy> <tests>` SHALL run every case, print each mismatch with the operations, matching rule and
actual decision, and exit non-zero if any case fails.

#### Scenario: Passing suite
- **WHEN** every case's decision matches its `expect`
- **THEN** the command prints the count and exits 0

#### Scenario: Regression
- **WHEN** a policy edit makes a case that expected `deny` now `allow`
- **THEN** the command names the case, the rule that now matches, and exits non-zero

### Requirement: policy_check accepts a candidate policy and identity
`policy_check` SHALL accept an optional `policy` path and `as` identity, and then decide offline
against that policy and identity instead of the loaded policy and signed-on user.

#### Scenario: Try a candidate
- **WHEN** `policy_check` is given `policy: ./candidate.yaml` and `as: { user: CTR01, partition: qa }`
- **THEN** it returns decisions under the candidate policy and sends nothing to the IBM i

### Requirement: The run log can be replayed against a candidate policy
`ibmi-agent-kit policy replay <candidate> [--since <days>]` SHALL re-decide every logged
statement with the candidate policy and the logged identity and lookups, and list each statement
whose decision would change, with old and new decision and rule.

#### Scenario: Before enforcing
- **WHEN** a team replays 14 days of observe-mode log against its draft enforce policy
- **THEN** the output lists every statement the draft would newly deny or confirm
