# Spec Delta

## Purpose

Lets people and teams keep repeatable IBM i procedures such as smoke and unit tests as files —
personal or reviewed in a repository — and run them through the guard so sharing one grants nothing.

## ADDED Requirements

### Requirement: Verbs are YAML files in three layers
A verb SHALL be one YAML file with `name`, `description`, optional `tags` and `params`, and lists
`setup`, `steps` and `cleanup`. Verbs SHALL load at startup from `~/.ibmi-agent-kit/verbs` (layer
`user`), from `.ibmi-kit/verbs/` in the working directory and from folders in `IBMI_KIT_VERBS`
(layer `proj`), and from `verbs/` beside the policy file (layer `org`). A file with an unknown key
SHALL be refused naming the file and key; other verbs still load.

#### Scenario: Unknown key
- **WHEN** a verb file contains `step:` instead of `steps:`
- **THEN** that verb is refused naming the file and key, and other verbs still load

#### Scenario: Project folder found automatically
- **WHEN** the server starts in a repository containing `.ibmi-kit/verbs/SMOKE-ORDERS.yaml`
- **THEN** `verb_list` shows `proj:SMOKE-ORDERS`

### Requirement: The closest layer wins a bare name
A verb SHALL be addressable as `user:NAME`, `proj:NAME` or `org:NAME`. A bare `NAME` SHALL
resolve to the first of `user`, `proj`, `org` that has it, and `verb_list` SHALL mark verbs it
hides. Two verbs with the same name in one layer SHALL both be refused, naming the files.

#### Scenario: Personal override
- **WHEN** `user:RESET-DATA` and `org:RESET-DATA` both exist and `verb_run` is given `RESET-DATA`
- **THEN** the user verb runs, and `verb_list` marks `org:RESET-DATA` as overridden

#### Scenario: Duplicate in one layer
- **WHEN** two project files both declare `SMOKE-ORDERS`
- **THEN** neither loads, and the error names both files

### Requirement: Parameters are typed and safe to substitute
Parameters SHALL declare a type (`string`, `integer`, `decimal`, `date`, `boolean`) and may
declare `required`, `default` and `allowed`. `:name` in SQL SHALL be sent as a bound parameter.
`${name}` SHALL be text substitution, allowed only for parameters with `allowed` or of a numeric,
date or boolean type, validated before substitution. A `${name}` reference that breaks this rule
SHALL refuse the verb at load.

#### Scenario: String parameter in text
- **WHEN** a verb uses `${env}` and `env` is a string with no `allowed`
- **THEN** the verb is refused at load, naming the parameter

#### Scenario: Value outside allowed
- **WHEN** `verb_run` passes `env: PRD` and `allowed` is `[IN1, IN2]`
- **THEN** the call fails before anything is sent

### Requirement: Every statement is decided by the guard as the signed-on user
Before running, every `setup`, `steps` and `cleanup` statement SHALL be substituted, classified
and decided for the signed-on user, server and partition, and one confirmation SHALL cover every
`confirm` operation. Any deny or a declined confirmation SHALL run nothing.

#### Scenario: Verb cannot widen access
- **WHEN** an analyst runs a project verb whose steps write a library the analyst's rules deny
- **THEN** nothing runs, and the result names the denied step

#### Scenario: Check a verb
- **WHEN** `policy_check` is given `verb: SMOKE-ORDERS` and arguments
- **THEN** it returns each step's operations, matching rule and decision, and runs nothing

### Requirement: Setup can require its test data to be absent
A setup step MAY declare `requires_absent`, a query; if it returns any row the verb SHALL fail
before that step runs, so a verb never overwrites or later deletes data it did not create.

#### Scenario: Test key already in use
- **WHEN** `requires_absent` finds an existing order with the verb's test key
- **THEN** the verb fails naming the step, and no setup or cleanup runs for it

### Requirement: Expectations fail the verb
An `expect` step SHALL run a read-only query and check `equals` values in the first row, a `rows`
count, or `empty`. The verb SHALL fail at the first expectation that does not hold, reporting
expected and actual values, and later steps SHALL NOT run.

#### Scenario: Value mismatch
- **WHEN** an expectation wants `{ STS: V }` and the query returns `{ STS: E }`
- **THEN** the verb fails at that step, reporting `V` expected and `E` found

### Requirement: Cleanup undoes only what setup did
After the steps finish or fail, each cleanup entry SHALL run only if the setup step it names in
`undoes` succeeded. Cleanup entries SHALL all be attempted even when one fails, and the result
SHALL report each.

#### Scenario: Setup failed
- **WHEN** a setup insert fails
- **THEN** the cleanup entry that undoes it does not run

#### Scenario: Steps failed
- **WHEN** setup succeeded and a step failed
- **THEN** every cleanup entry for a successful setup step runs and is reported

#### Scenario: Connection reset mid-verb
- **WHEN** the SQL connection is reset during a verb
- **THEN** the verb fails, cleanup is attempted on a new connection, and the result says QTEMP and the library list were lost

### Requirement: Nested verbs are bounded
A `verb` step SHALL call another verb by address with arguments. A cycle SHALL be refused at load
and a call chain SHALL hold at most 5 verbs, the top one counted.

#### Scenario: Cycle
- **WHEN** verb A calls B and B calls A
- **THEN** both are refused at load, naming the cycle

### Requirement: verb_run runs one verb or a tagged suite
`verb_run` with `verb` SHALL run that verb. With `tag` it SHALL run every verb carrying the tag in
address order using defaults, skip verbs whose required parameters have no default (naming them),
continue after failures, and report passed, failed and skipped counts with each result.

#### Scenario: Suite with a failure
- **WHEN** three `smoke` verbs run and the first fails
- **THEN** the other two still run and the report gives one failed and the others' outcomes

### Requirement: No tool writes verb files
No tool SHALL create, change or delete a verb file. Verbs SHALL load at startup only.

#### Scenario: Tool list
- **WHEN** the kit's tools are listed
- **THEN** no tool writes verb files
