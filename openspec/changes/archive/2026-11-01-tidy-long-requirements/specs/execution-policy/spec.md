## MODIFIED Requirements

### Requirement: Observe mode logs without blocking, per partition
`mode` SHALL be `observe`, `enforce`, or a map of partition names to modes with a `default`
(default `enforce` for a policy file). In observe mode operations are decided and logged and run
as if allowed, except that `danger` and `unqualified` operations and anything the engines' own
checks refuse SHALL still be denied (unknown commands excepted, see scenarios). A statement runs
only if every operation in it runs. The built-in policy SHALL be in observe mode.

#### Scenario: Observe a would-be deny
- **WHEN** in observe mode a statement would be denied
- **THEN** it runs, and the run log records `decision: deny, enforced: false`

#### Scenario: Danger still blocked while observing
- **WHEN** in observe mode `run_script` sends `CL: PWRDWNSYS OPTION(*IMMED)`
- **THEN** it is denied

#### Scenario: Unknown command observed
- **WHEN** in observe mode `run_script` sends `CL: FROBCMD X`
- **THEN** it runs, and the run log records `decision: deny, enforced: false, reason: unknown_command`

#### Scenario: Unknown command exception is narrow
- **WHEN** in observe mode a `danger` operation has a cause other than an unqualified (or `*LIBL`/`*NLVLIBL`) CL command missing from the command table
- **THEN** it is denied

#### Scenario: Unknown command enforced
- **WHEN** in enforce mode `run_script` sends `CL: FROBCMD X`
- **THEN** it is denied

#### Scenario: Qualified unknown command still blocked while observing
- **WHEN** in observe mode `run_script` sends `CL: MYLIB/FROBCMD X`
- **THEN** it is denied

#### Scenario: Unknown command next to a danger command
- **WHEN** in observe mode `run_script` sends `CL: FROBCMD X` and `CL: PWRDWNSYS OPTION(*IMMED)`
- **THEN** the script is denied and nothing is sent

#### Scenario: Stated limit, library list shadowing
- **WHEN** in observe mode `ADDLIBLE MYLIB` has run and an unqualified unknown `FROBCMD X` is sent
- **THEN** it runs `MYLIB/FROBCMD`; QSYS commands cannot be shadowed like this

#### Scenario: Command table is the boundary while observing
- **WHEN** in observe mode an IBM command is missing from the command table, whose `danger` entries are the boundary
- **THEN** it runs

#### Scenario: One partition enforced
- **WHEN** `mode: { default: observe, prod: enforce }` and a denied write targets the prod partition
- **THEN** it is blocked, while the same write on the dev partition is only logged

#### Scenario: No policy installed
- **WHEN** `IBMI_KIT_POLICY` is unset
- **THEN** every pre-existing tool behaves as before this change except that `danger` operations and unqualified changes are denied, and decisions are logged
