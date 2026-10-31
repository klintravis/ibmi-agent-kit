# Spec Delta

## Purpose

Lets a company express, in one reviewable file, what each kind of user may do on each partition
and library, so the kit can allow, confirm or deny every operation the same way for everyone.

## ADDED Requirements

### Requirement: The policy is one YAML file loaded at startup
The policy SHALL be read once at startup from the path in `IBMI_KIT_POLICY`. When unset, a
built-in default policy SHALL apply. An invalid policy file, including unknown keys, SHALL stop
the server with errors naming the file and key. The policy SHALL NOT be reloaded while running.

#### Scenario: Typo in a key
- **WHEN** the policy file contains `decison: allow`
- **THEN** the server refuses to start and the error names the file and `decison`

#### Scenario: No policy configured
- **WHEN** `IBMI_KIT_POLICY` is unset
- **THEN** the built-in default applies: reads allowed, writes and DDL in non-system libraries
  confirmed, everything else denied

### Requirement: The partition comes from the box itself
The policy SHALL map system names to partitions. After connecting, the kit SHALL read the box's
own system name (the SQL `CURRENT SERVER`, or the system name on the 5250 sign-on screen) and use
the matching partition. A box whose name matches no partition, or whose name cannot be read,
SHALL use the policy's `unknown_partition`.

#### Scenario: Profile named after the wrong box
- **WHEN** a profile file named `dev` connects to a box whose system name maps to partition `prod`
- **THEN** every decision uses partition `prod`

#### Scenario: Unknown box
- **WHEN** the box's system name matches no partition
- **THEN** decisions use `unknown_partition`

### Requirement: Libraries map to environments by ordered patterns
Each partition SHALL list environments in order, each with exact library names and/or patterns
(`*` wildcard, `$USER` for the signed-on user). The first environment that matches a library
SHALL be its environment. Exact names SHALL be checked before patterns within one entry. A
library matching no environment SHALL be in environment `unmatched`.

#### Scenario: First match wins
- **WHEN** partition `dev` lists `test: ["T*"]` before `system: ["Q*", "T*"]`
- **THEN** library `TSTLIB` is in environment `test`

#### Scenario: Personal library
- **WHEN** user `JDOE` touches library `JDOE` and the first environment is `personal: ["$USER"]`
- **THEN** the library is in environment `personal`, and `JDOEX` is not

### Requirement: Roles come from the user's group profiles
The policy SHALL map IBM i group profiles to roles in priority order. The role SHALL be the first
role in that order whose group appears in the user's group profile or supplemental groups. A user
in none SHALL get the policy's `default_role`. A failed lookup SHALL also give `default_role`.

#### Scenario: Two groups
- **WHEN** the role order is `qa, dev` and the user belongs to both mapped groups
- **THEN** the user's role is `qa`

#### Scenario: Lookup fails
- **WHEN** the group lookup cannot run
- **THEN** the user gets `default_role` and the run log records why

### Requirement: Ordered rules decide each operation, defaulting to deny
Every classified operation SHALL be decided by the first rule whose roles, partitions,
environments and classes all match it (each may be `*`). Its decision is `allow`, `confirm` or
`deny`. An operation no rule matches SHALL be denied. A statement SHALL take the most restrictive
decision of its operations (deny over confirm over allow).

#### Scenario: Default deny
- **WHEN** no rule matches a `ddl` operation on partition `qa`
- **THEN** the statement is denied, naming the operation and that no rule matched

#### Scenario: Read live, write own library
- **WHEN** a developer's rules allow `read` everywhere and `write` in `personal`, and they run
  `INSERT INTO JDOE.T SELECT * FROM PRODLIB.X`
- **THEN** the statement is allowed: the write is to `personal` and `PRODLIB.X` is only read

#### Scenario: One denied part denies the statement
- **WHEN** a script statement writes to two libraries and one write is denied
- **THEN** the whole statement is denied and nothing is sent

### Requirement: Policy examples use invented names only
The built-in default policy and every example policy in the repository SHALL use invented
partition, system, library and command names.

#### Scenario: Shipped examples
- **WHEN** the repository's example policies are loaded
- **THEN** they validate, and contain only names listed as invented in the examples' header
