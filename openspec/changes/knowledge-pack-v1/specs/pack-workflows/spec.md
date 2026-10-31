# Spec Delta

## Purpose

Captures an enterprise's green-screen business procedures as named, reviewable workflows that an
agent can run on a live 5250 session and that double as regression tests.

## ADDED Requirements

### Requirement: Workflows use the screen engine's test format
A pack workflow SHALL be a Markdown file in the pack's `workflows/` folder written in the same
`5250-do` / `5250-expect` block format the screen engine's `run_tests` accepts. Its first heading
SHALL be its title, and its file name (without extension) SHALL be its name.

#### Scenario: Workflow listed
- **WHEN** pack `sales` contains `workflows/release_credit_hold.md`
- **THEN** `pack_describe` lists workflow `release_credit_hold` with its title

#### Scenario: Malformed block
- **WHEN** a workflow contains a `5250-do` line the screen engine cannot parse
- **THEN** the pack is refused with an error naming the file and line

### Requirement: Workflows declare their inputs
A workflow MAY declare named inputs in a front-matter block, each with a type, required flag and
description. Inputs SHALL be referenced as `{{name}}` and SHALL only be substituted inside `type`
action values. A reference to an undeclared input SHALL be a load error.

#### Scenario: Input substituted
- **WHEN** `release_credit_hold` declares input `order` and contains `type f3: {{order}}`
- **THEN** running it with `order: 104233` types `104233` into field f3

#### Scenario: Missing required input
- **WHEN** `workflow_run` is called without a declared required input
- **THEN** the call fails before any key is sent, naming the missing input

### Requirement: workflow_run drives an open session and stops at the first failure
`workflow_run` SHALL run a workflow's steps in order on an open 5250 session, checking each
`5250-expect` block, and SHALL stop at the first failed expectation. It SHALL return each step's
outcome and the final screen snapshot. It SHALL be annotated destructive.

#### Scenario: Successful run
- **WHEN** every expectation in the workflow holds
- **THEN** the result reports all steps passed and includes the final screen

#### Scenario: Failure stops the run
- **WHEN** the second expectation fails
- **THEN** no later action is sent, and the result names the failed check and shows the screen

#### Scenario: No session open
- **WHEN** `workflow_run` is called and no 5250 session is open
- **THEN** it fails with an error telling the agent to call `session_open` first

### Requirement: Workflows obey the session's guards
Every action a workflow sends SHALL pass through the same restricted-mode and blocked-command
checks as `screen_do` on that session. A workflow SHALL NOT be able to bypass or relax them.

#### Scenario: Blocked command in a workflow
- **WHEN** a workflow types a CL command that restricted mode refuses
- **THEN** the run stops at that action with the guard's refusal, and the command is not sent

### Requirement: Workflows run as tests
`workflow_run` with `all: true` SHALL run every workflow in a pack as a test suite, in file-name
order, using declared input defaults, and report passed, failed and skipped counts, so the same
file serves as procedure and test.

#### Scenario: Pack workflows as a suite
- **WHEN** `workflow_run` is called with `pack: sales` and `all: true`
- **THEN** every workflow whose required inputs all have defaults runs, and the rest are reported
  as skipped with the missing input named

#### Scenario: One failure does not stop the suite
- **WHEN** the first of three workflows fails
- **THEN** the other two still run, and the suite reports one failed and two by their outcome
