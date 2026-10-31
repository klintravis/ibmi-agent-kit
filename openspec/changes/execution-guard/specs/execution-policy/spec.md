# Spec Delta

## Purpose

Lets a company express, in one reviewable file, what each kind of user may do on each partition
and library, and roll it out by observing before enforcing.

## ADDED Requirements

### Requirement: The policy is one YAML file loaded at startup
The policy SHALL be read once at startup from `IBMI_KIT_POLICY`. When unset, the built-in policy
SHALL apply. A set path that does not exist, a file that fails validation, or any unknown key
SHALL stop the server with errors naming the file and key. The policy SHALL NOT reload while
running.

#### Scenario: Typo in a key
- **WHEN** the policy file contains `decison: allow`
- **THEN** the server refuses to start and the error names the file and `decison`

#### Scenario: Missing file
- **WHEN** `IBMI_KIT_POLICY` names a file that does not exist
- **THEN** the server refuses to start naming the path

### Requirement: Observe mode logs without blocking
A policy SHALL declare `mode: observe` or `mode: enforce` (default `enforce` for a policy file).
In observe mode every operation SHALL be decided and logged and run as if allowed, except that
`danger` and `unqualified` operations SHALL still be denied, as SHALL anything the engines' own
checks refuse. The built-in policy SHALL be in observe mode.

#### Scenario: Observe a would-be deny
- **WHEN** in observe mode a statement would be denied
- **THEN** it runs, and the run log records `decision: deny, enforced: false`

#### Scenario: Danger still blocked while observing
- **WHEN** in observe mode `run_script` sends `CL: PWRDWNSYS OPTION(*IMMED)`
- **THEN** it is denied, because `PWRDWNSYS` is in the `danger` class

#### Scenario: No policy installed
- **WHEN** `IBMI_KIT_POLICY` is unset
- **THEN** every pre-existing tool behaves as before this change, and decisions are logged

### Requirement: The partition comes from the box, cross-checked with the profile
The policy SHALL map system names to partitions. After connecting, the kit SHALL read the box's
system name (SQL `CURRENT SERVER`, or the System field on the 5250 sign-on screen). A profile MAY
declare `IBMI_PARTITION`. If the declared and detected partitions differ, every guarded operation
on that server SHALL be denied naming both. An unreadable or unmapped name with no declaration
SHALL use `unknown_partition`.

#### Scenario: Profile named after the wrong box
- **WHEN** a profile named `dev` connects to a box whose system name maps to `prod`
- **THEN** every decision uses partition `prod`

#### Scenario: Declared and detected disagree
- **WHEN** a profile declares `IBMI_PARTITION=dev` and the box maps to `qa`
- **THEN** every guarded operation on that server is denied naming `dev` and `qa`

### Requirement: Libraries map to environments by ordered patterns
Each partition SHALL list environments in order, each with exact `libraries` and/or `match`
patterns (`*` wildcard, `$USER` for the signed-on user). The first environment that matches SHALL
be the library's environment; exact names are checked before patterns within one entry. A
library matching none SHALL be in environment `unmatched`.

#### Scenario: Order decides overlap
- **WHEN** partition `qa` lists `test: ["QT*"]` before `system: ["Q*"]`
- **THEN** library `QTORD` is in `test` and `QSYS2` is in `system`

#### Scenario: Personal library
- **WHEN** user `JDOE` touches `JDOE` and the first environment is `personal: ["$USER"]`
- **THEN** `JDOE` is in `personal` and `JDOEX` is not

### Requirement: Roles come from the user's group profiles
The policy SHALL list roles in priority order, each with IBM i group profiles. The user's role
SHALL be the first role holding the user's group profile or any supplemental group. Otherwise, or
if the lookup fails or returns no row, the role SHALL be `default_role`.

#### Scenario: Two groups
- **WHEN** roles are ordered `qa, dev` and the user holds both groups
- **THEN** the role is `qa`

#### Scenario: Lookup not permitted
- **WHEN** the group lookup returns no row for the user
- **THEN** the role is `default_role` and the run log records why

### Requirement: Ordered rules decide each operation, defaulting to deny
Each operation SHALL be decided by the first rule whose `roles`, `partition`, `env` and `classes`
all match; an omitted key or `*` matches anything. A rule's decision is `allow`, `confirm` or
`deny`. No matching rule SHALL mean deny. A statement SHALL take the most restrictive decision of
its operations (deny over confirm over allow).

#### Scenario: Default deny
- **WHEN** no rule matches a `ddl` operation on partition `qa`
- **THEN** it is denied, naming the operation and that no rule matched

#### Scenario: Read live, write own library
- **WHEN** rules allow `read` everywhere and `write` in `personal`, and a developer runs
  `INSERT INTO JDOE.T SELECT * FROM LIVLIB.X`
- **THEN** it is allowed: the write is to `personal` and `LIVLIB.X` is only read

#### Scenario: One denied part denies the statement
- **WHEN** a statement writes two libraries and one write is denied
- **THEN** the whole statement is denied

### Requirement: Examples use invented names only
The built-in policy and every example policy in the repository SHALL use invented partition,
system, library and command names, and SHALL pass the repository's private-name check.

#### Scenario: Shipped examples
- **WHEN** the example policies are loaded
- **THEN** they validate
