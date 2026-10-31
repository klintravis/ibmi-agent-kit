# Spec Delta

## Purpose

Turns SQL and CL text into a list of classed operations on library-qualified objects, so the
policy decides what a statement actually does rather than what its first word says.

## ADDED Requirements

### Requirement: Statements are split and read with literals and comments understood
A script SHALL be split into statements at semicolons outside string literals, delimited
identifiers and comments. SQL comments (`--`, `/* */`) SHALL be ignored for classification, and a
keyword inside a literal or comment SHALL NOT affect it. A line starting `CL:` SHALL be a CL
command.

#### Scenario: Semicolon inside a literal
- **WHEN** a script is `UPDATE A.T SET C = 'x;y' WHERE K = 1; SELECT * FROM A.T`
- **THEN** it splits into exactly two statements

#### Scenario: Keyword in a comment
- **WHEN** a statement is `SELECT * FROM A.T -- then DELETE FROM B.X`
- **THEN** it classifies as one `read` of `A.T` only

### Requirement: Each object an SQL statement touches is classed as read or changed
Classification SHALL produce one operation per object: `read` for objects only read; `write` for
data-change targets; `ddl` for objects created, altered, dropped, renamed, commented, labelled,
granted or revoked; `call` for called routines. Data changes nested in `FINAL TABLE`, `NEW TABLE`,
`OLD TABLE` or a common table expression SHALL be classed as writes.

#### Scenario: Write hidden in a select
- **WHEN** a statement is `SELECT * FROM FINAL TABLE (DELETE FROM B.X)`
- **THEN** it classifies as a `write` of `B.X`

#### Scenario: Insert from select
- **WHEN** a statement is `INSERT INTO A.T SELECT * FROM B.X`
- **THEN** it classifies as `write A.T` and `read B.X`

### Requirement: Embedded commands are classified as what they run
A literal command passed to `QSYS2.QCMDEXC` (as procedure or function), and a literal command or
statement inside CL `SBMJOB CMD(...)` or `RUNSQL SQL(...)`, SHALL be classified as that command or
statement. A non-literal argument to any of these SHALL classify as `danger`.

#### Scenario: CL through QCMDEXC
- **WHEN** a statement is `VALUES QSYS2.QCMDEXC('DLTLIB LIB(B)')`
- **THEN** it classifies as the CL command `DLTLIB` on library `B`

#### Scenario: Built command
- **WHEN** a statement is `CALL QSYS2.QCMDEXC(V_CMD)`
- **THEN** it classifies as `danger`

### Requirement: Routine and trigger bodies are classified
`CREATE PROCEDURE`, `CREATE FUNCTION` and `CREATE TRIGGER` SHALL classify as `ddl` of the new
object plus every operation in the body, so creating a routine that writes a library is decided
as a write to that library.

#### Scenario: Procedure that writes elsewhere
- **WHEN** a statement creates `A.P` whose body is `DELETE FROM B.X`
- **THEN** it classifies as `ddl A.P` and `write B.X`

### Requirement: Changed objects must name their library
Every `write`, `ddl` and CL object operation SHALL name its library explicitly, in SQL
(`LIB.OBJ`) or system (`LIB/OBJ`) naming, case-insensitively and with delimited names
normalised. An unqualified changed object SHALL classify as `unqualified` (denied by the default
policy). An unqualified read SHALL be classed against environment `unqualified`.

#### Scenario: Unqualified update
- **WHEN** a statement is `UPDATE T SET C = 1`
- **THEN** it classifies as `unqualified` with a message to name the library

#### Scenario: System naming
- **WHEN** a CL command is `CLRPFM FILE(B/X)`
- **THEN** it classifies as an operation on library `B`

### Requirement: CL commands come from a closed table
CL SHALL be classified only by a command table that gives each command a class (`read`,
`write`, `ddl`, `compile`, `promote`, `danger`) and the parameters that name libraries, with
`*LIBL`/`*CURLIB` treated as unqualified. The kit SHALL ship a table of common IBM commands, and
a policy MAY add commands. A command not in the table SHALL classify as `danger`.

#### Scenario: Display with an outfile
- **WHEN** a command is `DSPOBJD OBJ(A/*ALL) OBJTYPE(*FILE) OUTPUT(*OUTFILE) OUTFILE(B/OUT)`
- **THEN** it classifies as `read` of library `A` and `write` of `B/OUT`

#### Scenario: Vendor command from the policy
- **WHEN** the policy adds a command `PRMOBJ` with class `promote` and library parameter `TOLIB`
- **THEN** `PRMOBJ OBJ(X) TOLIB(QAL1)` classifies as `promote` on library `QAL1`

#### Scenario: Unknown command
- **WHEN** a command is not in the table
- **THEN** it classifies as `danger`, naming the command

### Requirement: Opaque statements classify as danger
Statements whose effect cannot be read from their text SHALL classify as `danger`: `EXECUTE
IMMEDIATE`, `PREPARE`, CL `QSH`/`STRQSH`, `STRREXPRC`, and any statement the tokenizer cannot
parse. CL `CALL PGM(LIB/PGM)` SHALL classify as `call` on `LIB`, like an SQL `CALL`.

#### Scenario: Unparseable statement
- **WHEN** a statement cannot be parsed
- **THEN** it classifies as `danger` with the parse error
