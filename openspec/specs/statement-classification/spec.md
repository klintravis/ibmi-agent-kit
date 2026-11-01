# statement-classification Specification

## Purpose
Turns SQL and CL text into a list of classed operations on library-qualified objects, so the
policy decides what a statement actually does rather than what its first word says.

## Requirements

### Requirement: Statements are split with literals and comments understood
A script SHALL be split at semicolons outside string literals, delimited identifiers and
comments. Comments SHALL be ignored for classification and stripped from what a confirmation
shows. A line starting `CL:` (any case) SHALL be one CL command, continued on following lines
while a line ends with `+`.

#### Scenario: Semicolon inside a literal
- **WHEN** a script is `UPDATE A.T SET C = 'x;y' WHERE K = 1; SELECT * FROM A.T`
- **THEN** it splits into exactly two statements

#### Scenario: Keyword in a comment
- **WHEN** a statement is `SELECT * FROM A.T -- then DELETE FROM B.X`
- **THEN** it classifies as one `read` of `A.T`

### Requirement: Each object an SQL statement touches is classed
Classification SHALL produce one operation per object: `read`; `write` for data-change targets;
`ddl` for objects created, altered, dropped, renamed, commented, labelled, granted or revoked;
`call` for called procedures and for every function that is not a Db2 built-in. Data changes in
`FINAL TABLE`, `NEW TABLE`, `OLD TABLE` or a common table expression SHALL be writes.

#### Scenario: Write hidden in a select
- **WHEN** a statement is `SELECT * FROM FINAL TABLE (DELETE FROM B.X)`
- **THEN** it classifies as `write B.X`

#### Scenario: User function in a select
- **WHEN** a statement is `SELECT DEVLIB.WIPE() FROM SYSIBM.SYSDUMMY1`
- **THEN** it classifies as `call DEVLIB.WIPE` and `read SYSIBM.SYSDUMMY1`

### Requirement: Aliases and views resolve to their base objects
Before deciding, every changed object that is an alias or a view SHALL also be classed against
each base table it resolves to, looked up on the box at decision time. An object that cannot be
looked up SHALL classify as `danger` naming the failed lookup, so the statement is denied in every
mode rather than decided as the object alone.

#### Scenario: Alias lookup fails
- **WHEN** the base-table lookup for `QTEMP.A` errors and a statement writes through `QTEMP.A`
- **THEN** the statement is denied with a message that the alias/view bases could not be resolved

#### Scenario: Alias in QTEMP
- **WHEN** a script runs `CREATE ALIAS QTEMP.A FOR LIVLIB.ORD` then `DELETE FROM QTEMP.A`
- **THEN** the delete classifies as `write QTEMP.A` and `write LIVLIB.ORD`

### Requirement: Embedded commands are classified as what they run
A literal command passed to `QCMDEXC` (procedure or function, in `QSYS2` or `QSYS`) and a literal
statement in CL `RUNSQL SQL(...)` SHALL classify as that command or statement. A non-literal
argument, `QCAPCMD`, and every `SBMJOB` SHALL classify as `danger`.

#### Scenario: CL through QCMDEXC
- **WHEN** a statement is `VALUES QSYS2.QCMDEXC('DLTLIB LIB(B)')`
- **THEN** it classifies as CL `DLTLIB` on library `B`

#### Scenario: Built command
- **WHEN** a statement is `CALL QSYS2.QCMDEXC('DLT' || 'LIB B')`
- **THEN** it classifies as `danger`

### Requirement: Routine and trigger bodies are classified
`CREATE PROCEDURE`, `CREATE FUNCTION` and `CREATE TRIGGER` SHALL classify as `ddl` of the new
object plus every operation in its body.

#### Scenario: Procedure that writes elsewhere
- **WHEN** a statement creates `A.P` whose body is `DELETE FROM B.X`
- **THEN** it classifies as `ddl A.P` and `write B.X`

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

### Requirement: Libraries are matched by their system name
A library named by its long SQL schema name SHALL be resolved to its system name at decision
time, and environments SHALL match the system name only, so SQL and CL naming of one library
always land in the same environment.

#### Scenario: Long schema name
- **WHEN** a statement writes `ORDER_HISTORY.T` and that schema's system name is `ORDER00001`
- **THEN** the write is matched against environments as `ORDER00001`

### Requirement: Statements reaching another database are danger unless mapped
`CONNECT`, `SET CONNECTION`, `DISCONNECT`, an `RDB(...)` CL parameter, and a three-part name
(`RDB.LIB.OBJ`) SHALL classify as `danger`, unless the RDB is listed by a partition, in which case
the operation SHALL be decided against that partition's environments.

#### Scenario: Unmapped remote insert
- **WHEN** a statement is `INSERT INTO OTHERRDB.LIB.T VALUES (1)` and no partition lists `OTHERRDB`
- **THEN** it classifies as `danger`

#### Scenario: Mapped remote read
- **WHEN** a statement reads `QARDB.QTORD.T` and partition `qa` lists `rdbs: [QARDB]`
- **THEN** it classifies as `read` of `QTORD` on partition `qa`

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

### Requirement: Commands can take their class from a parameter value
A command entry MAY declare `class_by_param` (a parameter, a map of its values to classes, and a
default class) and the product `library` it must be qualified to. Classes other than the built-in
ones SHALL be declared by being used in a command entry, and rules SHALL be able to name them, so a
change-management product that promotes by request and level can be governed per level.

#### Scenario: Promote by level
- **WHEN** `CMPRM` declares `class_by_param: { param: LEVEL, values: { QA: promote_qa, PROD: promote_prod }, default: danger }`
- **THEN** `CMPRM REQ(1234) LEVEL(QA)` classifies as `promote_qa` and `LEVEL(PROD)` as `promote_prod`

#### Scenario: Unlisted level
- **WHEN** `CMPRM REQ(1234) LEVEL(HOTFIX)` is classified
- **THEN** it classifies as `danger`

### Requirement: Opaque statements classify as danger
`EXECUTE IMMEDIATE`, `PREPARE`, CL `QSH`/`STRQSH`, `STRREXPRC`, and any statement the tokenizer
cannot parse SHALL classify as `danger`. CL `CALL PGM(LIB/PGM)` SHALL classify as `call` on `LIB`.

#### Scenario: Unparseable statement
- **WHEN** a statement cannot be parsed
- **THEN** it classifies as `danger` with the parse error

### Requirement: The shipped table covers an ILE build
The shipped command table SHALL classify the commands of an ILE build in the user's own library,
including binding directories and message files. A binding-directory entry command SHALL classify
as `ddl` of the directory and `read` of each object an entry names. A parameter naming a program
that runs later for other users SHALL classify as `danger`. A list given by position SHALL classify
like the same list given by keyword.

#### Scenario: Binding directory entry
- **WHEN** a command is `ADDBNDDIRE BNDDIR(A/BD) OBJ((A/S *SRVPGM))`
- **THEN** it classifies as `ddl` of `A/BD` and `read` of `A/S`

#### Scenario: Message description with a default program
- **WHEN** a command is `ADDMSGD MSGID(USR0001) MSGF(A/MSGF) MSG('Hello') DFTPGM(B/P)`
- **THEN** it classifies as `ddl` of `A/MSGF` and `danger` for `B/P`

#### Scenario: Positional list
- **WHEN** a command is `CHGLIBL (A B C)`
- **THEN** it classifies as `liblist` of `A`, `B` and `C`, the same as `CHGLIBL LIBL(A B C)`
