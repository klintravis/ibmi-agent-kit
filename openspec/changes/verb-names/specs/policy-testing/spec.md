## ADDED Requirements

### Requirement: policy test refuses verb files the server would refuse
`ibmi-agent-kit policy test` SHALL load the verbs of the project folder and beside the policy file
whether or not a case names a verb, print each refusal, and exit non-zero when any verb file is
refused. A policy with no verb folders SHALL behave as before.

#### Scenario: Refused verb, no verb case
- **WHEN** a verb file beside the policy is refused at load and no test case names a verb
- **THEN** the command prints the refusal, still runs every case, and exits 1

#### Scenario: No verb folders
- **WHEN** neither verb folder exists
- **THEN** the command behaves as before
