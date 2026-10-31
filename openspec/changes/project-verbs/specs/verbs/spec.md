# Spec Delta

## Purpose

Lets a team keep repeatable IBM i procedures such as smoke and unit tests as reviewed files in
their own repository, and run them through the execution guard so sharing one grants nothing.

## ADDED Requirements

### Requirement: Verbs are YAML files in two layers
A verb SHALL be one YAML file with `name`, `description`, optional `tags` and `params`, and lists
`setup`, `steps` and `cleanup`. Verbs SHALL load from folders in `IBMI_KIT_VERBS` as layer `proj`
and from `verbs/` beside the policy file as layer `org`, and be addressed as `proj:<name>` or
`org:<name>`. Two verbs with the same address SHALL refuse both, naming the files.

#### Scenario: Same name in two layers
- **WHEN** `org:RESET-DATA` and `proj:RESET-DATA` both exist
- **THEN** both load and `verb_list` shows them as two verbs with their layers

#### Scenario: Duplicate in one layer
- **WHEN** two files in the project folders both declare `SMOKE-ORDERS`
- **THEN** neither loads, and the error names both files

#### Scenario: Unknown key
- **WHEN** a verb file contains `step:` instead of `steps:`
- **THEN** that verb is refused naming the file and key, and other verbs still load

### Requirement: Parameters are typed and safe to substitute
Parameters SHALL declare a type (`string`, `integer`, `decimal`, `date`, `boolean`) and may declare
`required`, `default` and `allowed`. A parameter used inside an SQL value SHALL be bound, not
substituted. A parameter used in an identifier position, such as a library name, or in a CL
command SHALL declare `allowed`; a string substituted into CL SHALL have quotes escaped.

#### Scenario: Identifier parameter without allowed values
- **WHEN** a verb uses `${env}` in a library name and `env` declares no `allowed`
- **THEN** the verb is refused at load, naming the parameter

#### Scenario: Value outside allowed
- **WHEN** `verb_run` passes `env: PRD` and `allowed` is `[IN1, IN2]`
- **THEN** the call fails before anything is sent

### Requirement: Every step is decided by the guard as the signed-on user
Before running, every `setup`, `steps` and `cleanup` statement SHALL be substituted and then
classified and decided by the execution guard for the signed-on user, server and partition. If
any statement would be denied, nothing SHALL run. Confirmations SHALL be asked statement by
statement as they run.

#### Scenario: Verb cannot widen access
- **WHEN** an analyst runs a project verb whose steps write to a library the analyst's rules deny
- **THEN** the verb is refused before any step runs, naming the denied step

#### Scenario: verb_check
- **WHEN** `verb_check` is called with a verb and arguments
- **THEN** it returns each step's operations, matching rule and decision, and runs nothing

### Requirement: Expectations fail the verb
An `expect` step SHALL run a read-only query and check `equals` values in the first row,
`rows` count, or `empty`, and the verb SHALL fail at the first expectation that does not hold,
reporting expected and actual values.

#### Scenario: Value mismatch
- **WHEN** an expectation wants `{ STS: 'V' }` and the query returns `{ STS: 'E' }`
- **THEN** the verb fails at that step, reporting `V` expected and `E` found, and later steps do not run

### Requirement: Cleanup undoes only what setup did
After the steps finish or fail, `cleanup` SHALL run. Each cleanup entry SHALL name the setup
step it undoes, and SHALL run only if that setup step succeeded. Cleanup entries SHALL run even
when an earlier cleanup entry fails, and the result SHALL report each one.

#### Scenario: Setup collided with real data
- **WHEN** a setup insert fails because the row already exists, and its cleanup deletes that row
- **THEN** that cleanup entry does not run, and the existing row is left alone

#### Scenario: Steps failed
- **WHEN** setup succeeded and a step failed
- **THEN** every cleanup entry for successful setup steps runs and the result reports each

### Requirement: Nested verbs are bounded
A `verb` step SHALL call another verb by address with arguments. A cycle SHALL be refused at load
and nesting SHALL be limited to 5 levels.

#### Scenario: Cycle
- **WHEN** verb A calls B and B calls A
- **THEN** both are refused at load, naming the cycle

### Requirement: verb_test runs a tagged suite
`verb_test` SHALL run every verb with a given tag in address order using parameter defaults,
skip verbs whose required parameters have no default (naming the parameter), continue after a
failure, and report passed, failed and skipped counts with each verb's result.

#### Scenario: Suite with a failure
- **WHEN** three `smoke` verbs run and the first fails
- **THEN** the other two still run and the report gives one failed and the others' outcomes

### Requirement: Verbs enter only through files
No tool SHALL create, change or save a verb file. Verbs SHALL be loaded at startup only.

#### Scenario: No save tool
- **WHEN** the kit's tools are listed
- **THEN** no tool writes verb files
