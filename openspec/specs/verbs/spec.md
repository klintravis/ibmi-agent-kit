# verbs Specification

## Purpose
Lets people and teams keep repeatable IBM i procedures such as smoke and unit tests as files —
personal or reviewed in a repository — and run them through the guard so sharing one grants nothing.

## Requirements

### Requirement: Verbs are YAML files in three layers
A verb SHALL be one YAML file with `name`, `description`, optional `tags` and `params`, and lists
`setup`, `steps` and `cleanup`, loaded from `~/.ibmi-agent-kit/verbs` (layer `user`), from
`.ibmi-kit/verbs/` in the working directory and the profile's `IBMI_KIT_VERBS` folders (layer
`proj`), and from `verbs/` beside the profile's policy file (layer `org`). A file with an unknown
key SHALL be refused naming the file and key; other verbs still load.

#### Scenario: Loaded on the first verb call
- **WHEN** the first verb tool call names a server
- **THEN** that server's verbs load once and are not reloaded; a relative `IBMI_KIT_VERBS` folder is refused

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
Parameters SHALL declare a type (`string`, `name`, `integer`, `decimal`, `date`, `boolean`) and may
declare `required`, `default` and `allowed`. `:name` in SQL SHALL be sent as a bound parameter.
`${name}` SHALL be text substitution, allowed only for parameters with `allowed` or of the `name`,
integer, decimal, date or boolean type, validated before substitution. A `${name}` reference that
breaks this rule SHALL refuse the verb at load.

#### Scenario: String parameter in text
- **WHEN** a verb uses `${env}` and `env` is a string with no `allowed`
- **THEN** the verb is refused at load, naming the parameter

#### Scenario: Value outside allowed
- **WHEN** `verb_run` passes `env: PRD` and `allowed` is `[IN1, IN2]`
- **THEN** the call fails before anything is sent

#### Scenario: Name parameter in CL
- **WHEN** a verb's CL step is `CMPRD/CMCHKOUT TASK(${task}) MBR(${member})` and `member` has type `name`
- **THEN** the verb loads, and `verb_run` with `member: ordval` sends `MBR(ORDVAL)`

#### Scenario: Name is an object name
- **WHEN** a `name` argument is `A'B`, `A B`, `A(B)`, `A&B`, `A,B`, `A/B`, `A.B`, `A.`, an empty string, a name starting with a digit or one of 11 characters
- **THEN** the call fails before anything is sent, naming the parameter

#### Scenario: Name outside quotes in SQL
- **WHEN** a verb's SQL step is `GRANT SELECT ON ORDLIB.ORDHDR TO ${u}` and `u` has type `name` and the call passes `public`
- **THEN** the statement sent is `... TO PUBLIC`, because outside quotes a name is an identifier or keyword; `:u` or `'${u}'` is how a value is passed

#### Scenario: Name with allowed
- **WHEN** a `name` parameter has `allowed: [ordhdr]`
- **THEN** `ORDHDR` and `ordhdr` are accepted and anything else is refused, and an `allowed` value that is not a name refuses the verb at load

#### Scenario: Name that is a production library
- **WHEN** a verb's CL step is `CHGDTAARA DTAARA(${lib}/DA) VALUE('X')` with `lib` of type `name` and a call passes a library that an environment rule denies
- **THEN** the guard denies the substituted statement like a literal one

### Requirement: Every statement is decided by the guard as the signed-on user
Before running, every `setup`, `steps` and `cleanup` statement of every verb in the call SHALL be
substituted, classified as one script in run order and decided for the signed-on user, server and
partition, and one confirmation SHALL cover every `confirm` operation. A verb with a deny SHALL run
nothing, and a declined confirmation SHALL run no verb of the call.

#### Scenario: Suite cannot set up a way past the guard
- **WHEN** a `smoke` suite's first verb creates `QTEMP.A` as an alias of a live table and the next deletes from `QTEMP.A`
- **THEN** the second verb is denied as a write to the live table and sends nothing

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
`undoes` succeeded. Cleanup entries SHALL all be attempted even when one fails, unless the
connection was reset, and the result SHALL report each.

#### Scenario: Setup failed
- **WHEN** a setup insert fails
- **THEN** the cleanup entry that undoes it does not run

#### Scenario: Steps failed
- **WHEN** setup succeeded and a step failed
- **THEN** every cleanup entry for a successful setup step runs and is reported

#### Scenario: Connection reset mid-verb
- **WHEN** the SQL connection is reset during a verb
- **THEN** the verb fails, nothing more is sent (cleanup and later verbs of the call included, on any job), and the result lists the cleanup statements not run so the user can clean up by hand

### Requirement: Nested verbs are bounded
A `verb` step SHALL call another verb by address with arguments. A cycle SHALL be refused at load
and a call chain SHALL hold at most 5 verbs, the top one counted.

#### Scenario: Cycle
- **WHEN** verb A calls B and B calls A
- **THEN** both are refused at load, naming the cycle

### Requirement: verb_run runs one verb or a tagged suite
`verb_run` with `verb` SHALL run that verb. With `tag` it SHALL run every verb carrying the tag in
address order using defaults, skip verbs whose required parameters have no default (naming them),
and report passed, failed and skipped counts with each result. Because later verbs are decided as
if every earlier one ran in full, once a verb is refused or does not run in full (a
`requires_absent` hit, a failure) no later verb SHALL be sent; each is reported as not sent.

#### Scenario: Suite with a failure
- **WHEN** three `smoke` verbs run and the first fails partway
- **THEN** the first verb's successful setups are still cleaned up, the other two are reported "not sent: an earlier verb in this call did not run in full", and the report counts three failed

### Requirement: No tool writes verb files
No tool SHALL create, change or delete a verb file. Verbs SHALL load only from files, once per
server.

#### Scenario: Tool list
- **WHEN** the kit's tools are listed
- **THEN** no tool writes verb files
