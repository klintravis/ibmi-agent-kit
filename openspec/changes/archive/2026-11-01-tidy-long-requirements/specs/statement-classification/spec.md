## MODIFIED Requirements

### Requirement: Changed objects name their library
Every changed object SHALL name its library, in SQL (`LIB.OBJ`) or system (`LIB/OBJ`) naming,
case-insensitively with delimited names normalised. `*CURLIB` SHALL be resolved to the job's
current library at decision time unless an earlier statement of the script holds a `liblist`
operation. Any other unqualified changed object, or `*LIBL`, SHALL classify as `unqualified`,
which no rule can allow. Unqualified reads and calls keep their class.

#### Scenario: Unqualified update
- **WHEN** a statement is `UPDATE T SET C = 1`
- **THEN** it classifies as `unqualified` with a message to name the library

#### Scenario: Current library compile
- **WHEN** a compile targets `*CURLIB` and the job's current library is `JDOE`
- **THEN** it classifies as `compile` into `JDOE`

#### Scenario: Current library changed earlier in the script
- **WHEN** a script runs `CL: CHGCURLIB LVORD` then `CL: CLRPFM FILE(*CURLIB/ORDERS)`
- **THEN** the clear classifies as `unqualified`, saying the script changes the current library

#### Scenario: Liblist operation inside a wrapper
- **WHEN** an earlier statement holds a `liblist` operation inside `QCMDEXC` or `RUNSQL`
- **THEN** it counts as a `liblist` operation, so a later change through `*CURLIB` is `unqualified`

#### Scenario: Unqualified call
- **WHEN** a statement is `CALL MYPROC()` or a CL command is `CALL PGM(ORDVAL)`
- **THEN** it classifies as `call` in environment `unqualified`, not as `unqualified`

#### Scenario: Unqualified read
- **WHEN** a statement reads an object with no library, or through `*LIBL/X`
- **THEN** it keeps its `read` class in environment `unqualified`, so rules decide it

### Requirement: CL commands come from a closed table
CL SHALL be classified only by a command table giving each command a class (`read`, `write`,
`ddl`, `compile`, `call`, `liblist`, `promote`, `danger`), the parameters that name objects or
libraries, and optionally the partition a parameter's library belongs to. A command not in the
table, or qualified to a library other than `QSYS`, `QSYS2` or one the table names, SHALL
classify as `danger`; the unqualified ones SHALL carry the reason `unknown_command`.

#### Scenario: Display with an outfile
- **WHEN** a command is `DSPOBJD OBJ(A/*ALL) OBJTYPE(*FILE) OUTPUT(*OUTFILE) OUTFILE(B/OUT)`
- **THEN** it classifies as `read` of library `A` and `write` of `B/OUT`

#### Scenario: Promotion to another partition
- **WHEN** the policy adds `PRMOBJ` with class `promote` and parameter `TOLIB` on partition `qa`
- **THEN** `PRMOBJ OBJ(X) TOLIB(QTORD)` run on the dev partition classifies as `promote` into
  `QTORD` matched against partition `qa`'s environments

#### Scenario: Shipped table and policy additions
- **WHEN** the kit ships its common IBM commands
- **THEN** a policy MAY add or override commands in that table

#### Scenario: Unknown command
- **WHEN** a command is `FROBCMD X`
- **THEN** it classifies as `danger` with reason `unknown_command`

#### Scenario: Unknown command qualified to the library list
- **WHEN** a command missing from the table is qualified `*LIBL` or `*NLVLIBL`
- **THEN** it carries the reason `unknown_command`, like an unqualified one

#### Scenario: Look-alike command
- **WHEN** a command is `MYLIB/DSPOBJD OBJ(A/X) OBJTYPE(*FILE)`
- **THEN** it classifies as `danger`

#### Scenario: Qualified unknown command has no unknown_command reason
- **WHEN** a command missing from the table is qualified to a named library
- **THEN** it classifies as `danger` without the reason `unknown_command`, so the qualifier rule wins

#### Scenario: Unknown command that may run another command
- **WHEN** an unknown command has a `CMD(` or `RQSDTA(` parameter
- **THEN** it does not carry the reason `unknown_command`, since it may run that command where the guard does not see it
