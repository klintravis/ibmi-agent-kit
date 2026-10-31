# Spec Delta

## Purpose

Lets any IBM i shop express, in one reviewable file, what each kind of user may do on each
partition and library — whatever its change-management ladder, partition layout or security
model — and roll it out by observing before enforcing.

## ADDED Requirements

### Requirement: The policy is one YAML file loaded at startup
The policy SHALL be read once at startup from `IBMI_KIT_POLICY` with a YAML 1.2 core schema, so a
value such as `NO` stays a string. When unset, the built-in policy SHALL apply. A missing file, a
validation failure or an unknown key SHALL stop the server with errors naming the file and key.
The policy SHALL NOT reload while running.

#### Scenario: Typo in a key
- **WHEN** the policy file contains `decison: allow`
- **THEN** the server refuses to start and the error names the file and `decison`

#### Scenario: Missing file
- **WHEN** `IBMI_KIT_POLICY` names a file that does not exist
- **THEN** the server refuses to start naming the path

#### Scenario: Unquoted star
- **WHEN** a value starts with an unquoted `*`
- **THEN** the error names the line and says to quote values starting with `*`

### Requirement: Command tables can live in their own files
A policy MAY list `command_files`, paths relative to the policy file, each holding only a
`commands:` section, merged in order before the policy's own `commands:`. Rules, environments
and roles SHALL NOT be includable.

#### Scenario: Vendor command file
- **WHEN** a policy lists `command_files: [cm-product.yaml]`
- **THEN** that file's commands are classified as if written in the policy, and an error in it names that file

### Requirement: Observe mode logs without blocking, per partition
`mode` SHALL be `observe`, `enforce`, or a map of partition names to modes with a `default`
(default `enforce` for a policy file). In observe mode operations are decided and logged and run
as if allowed, except that `danger` and `unqualified` operations and anything the engines' own
checks refuse SHALL still be denied. The one exception is a `danger` operation whose only cause is
an unqualified (or `*LIBL`/`*NLVLIBL`) CL command missing from the command table (reason
`unknown_command`): in observe mode it is logged as `decision: deny, enforced: false` with that
reason and runs. This is a stated limit: after `ADDLIBLE MYLIB`, an unqualified unknown `FROBCMD X`
observed this way runs `MYLIB/FROBCMD`; QSYS commands cannot be shadowed like this. Likewise the
command table's `danger` entries are the boundary while observing: an IBM command missing from the
table runs in observe mode. A statement
runs only if every operation in it runs. The built-in policy SHALL be
in observe mode.

#### Scenario: Observe a would-be deny
- **WHEN** in observe mode a statement would be denied
- **THEN** it runs, and the run log records `decision: deny, enforced: false`

#### Scenario: Danger still blocked while observing
- **WHEN** in observe mode `run_script` sends `CL: PWRDWNSYS OPTION(*IMMED)`
- **THEN** it is denied

#### Scenario: Unknown command observed
- **WHEN** in observe mode `run_script` sends `CL: FROBCMD X`
- **THEN** it runs, and the run log records `decision: deny, enforced: false, reason: unknown_command`

#### Scenario: Unknown command enforced
- **WHEN** in enforce mode `run_script` sends `CL: FROBCMD X`
- **THEN** it is denied

#### Scenario: Qualified unknown command still blocked while observing
- **WHEN** in observe mode `run_script` sends `CL: MYLIB/FROBCMD X`
- **THEN** it is denied

#### Scenario: Unknown command next to a danger command
- **WHEN** in observe mode `run_script` sends `CL: FROBCMD X` and `CL: PWRDWNSYS OPTION(*IMMED)`
- **THEN** the script is denied and nothing is sent

#### Scenario: One partition enforced
- **WHEN** `mode: { default: observe, prod: enforce }` and a denied write targets the prod partition
- **THEN** it is blocked, while the same write on the dev partition is only logged

#### Scenario: No policy installed
- **WHEN** `IBMI_KIT_POLICY` is unset
- **THEN** every pre-existing tool behaves as before this change, and decisions are logged

### Requirement: Partitions are identified by system name and RDB name
Each partition SHALL list `systems` (matched against the 5250 sign-on System name, which some sign-on screens label "Server name") and/or `rdbs`
(matched against SQL `CURRENT SERVER`, including IASP database names). A profile MAY declare
`IBMI_PARTITION`. Detected names, and any declaration, SHALL agree on one partition; if they map
to different partitions every guarded operation on that server SHALL be denied naming them. No
match and no declaration SHALL use `unknown_partition`.

#### Scenario: Profile named after the wrong box
- **WHEN** a profile named `dev` connects to a box whose RDB name maps to `prod`
- **THEN** every decision uses partition `prod`

#### Scenario: IASP database name
- **WHEN** `CURRENT SERVER` returns `QAIASP1` and partition `qa` lists `rdbs: [QARDB, QAIASP1]`
- **THEN** decisions use partition `qa`

#### Scenario: Names disagree
- **WHEN** the System name maps to `dev` and the RDB name maps to `qa`
- **THEN** every guarded operation on that server is denied naming `dev` and `qa`

### Requirement: Libraries map to environments by one ordered list
`environments` SHALL be one ordered list; each entry has a `name`, exact `libraries` and/or
`match` patterns (`*` wildcard, `${USER}` for the signed-on user), and optionally `partitions` to
limit where it applies. The first entry that applies to the partition and matches the library's
system name SHALL be its environment; exact names are checked before patterns in one entry. No
match SHALL be environment `unmatched`.

#### Scenario: Shared entry
- **WHEN** an entry `{ name: blocked, libraries: [PAYLIB] }` has no `partitions`
- **THEN** `PAYLIB` is `blocked` on every partition

#### Scenario: Order decides overlap
- **WHEN** `{ name: test, match: ["QT*"], partitions: [qa] }` comes before `{ name: system, match: ["Q*"] }`
- **THEN** on partition `qa`, `QTORD` is `test` and `QSYS2` is `system`

#### Scenario: Personal library
- **WHEN** user `JDOE` touches `JDOE` and the first entry is `personal: ["${USER}"]`
- **THEN** `JDOE` is `personal` and `JDOEX` is not

### Requirement: Users can hold several roles from several sources
Each role SHALL list any of `groups` (group profile or supplemental group), `authlists`
(authorization lists naming the user) and `users` (user names or patterns). A user SHALL hold
every role whose sources match, or `default_role` if none match or the lookup fails.

#### Scenario: Dev and QA
- **WHEN** a user is in both the dev and the QA group
- **THEN** they hold both roles, and any rule naming either role can match

#### Scenario: Per-user exception
- **WHEN** role `dev` lists `users: [JDOE]` and `JDOE` is in no mapped group
- **THEN** `JDOE` holds `dev`

#### Scenario: Lookup not permitted
- **WHEN** the identity lookup returns no row
- **THEN** the user holds `default_role` and the run log records why

### Requirement: Ordered rules decide each operation, defaulting to deny
Each operation SHALL be decided by the first rule whose `roles` (any held role), `partition`,
`env` and `classes` all match; an omitted key or the word `any` matches anything. A rule's
decision is `allow`, `confirm` or `deny`. No matching rule SHALL mean deny. A statement SHALL take
the most restrictive decision of its operations.

#### Scenario: Default deny
- **WHEN** no rule matches a `ddl` operation on partition `qa`
- **THEN** it is denied, naming the operation and that no rule matched

#### Scenario: Read live, write own library
- **WHEN** rules allow `read` everywhere and `write` in `personal`, and a developer runs
  `INSERT INTO JDOE.T SELECT * FROM LIVLIB.X`
- **THEN** it is allowed

#### Scenario: One denied part denies the statement
- **WHEN** a statement writes two libraries and one write is denied
- **THEN** the whole statement is denied

### Requirement: References are checked and shadowing is reported
Loading SHALL fail when a rule names an undefined environment, role, partition or class. It
SHALL warn when an environment entry or exact name can never match because an earlier entry
covers it, and when a rule can never match because an earlier rule covers it.

#### Scenario: Undefined environment
- **WHEN** a rule names `env: intgr` and no environment is called `intgr`
- **THEN** the server refuses to start naming the rule and `intgr`

#### Scenario: Shadowed environment
- **WHEN** `{ name: system, match: ["Q*"] }` comes before `{ name: test, match: ["QT*"] }` on the same partitions
- **THEN** a warning names both entries

### Requirement: Examples use invented names only
Every example and template policy in the repository SHALL use invented names and SHALL pass the
repository's private-name check and its own policy tests.

#### Scenario: Shipped examples
- **WHEN** the example policies and their test files are run with `policy test`
- **THEN** every case passes
