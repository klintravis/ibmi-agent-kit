# Spec Delta

## ADDED Requirements

### Requirement: Undeclared CL parameters are flagged
When a CL command from the command table is given, by keyword, a parameter its entry does not name
(in `params`, `writes`, `positional`, `class_by_param` or `nested_sql`), and that parameter's value
holds a name (an element that is not quoted, numeric or a `*` special value), classification SHALL
add a warning to that statement naming the command and the keyword. The warning SHALL NOT change
any operation or decision.

#### Scenario: Undeclared keyword
- **WHEN** the table has `XYZCPY: { class: write, positional: [FROMOBJ], params: { FROMOBJ: object } }`
  and a script runs `CL: XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)`
- **THEN** the statement carries a warning naming `XYZCPY` and `TOLIB`, saying a library or object
  it names is not decided

#### Scenario: Declared keywords only
- **WHEN** a script runs `CL: DSPOBJD OBJ(A/*ALL) OBJTYPE(*FILE) OUTPUT(*OUTFILE) OUTFILE(B/OUT)`
- **THEN** the statement carries no warning

#### Scenario: Value that names nothing
- **WHEN** a script runs `CL: CRTBNDRPG PGM(APPLIB/ORD) SRCFILE(APPLIB/QRPGLESRC) DBGVIEW(*SOURCE) TEXT('Orders')`
- **THEN** the statement carries no warning

#### Scenario: Decision unchanged
- **WHEN** the `XYZCPY` statement above is decided with and without the warning check
- **THEN** its operations, matching rules and decision are the same: `write` of `APPLIB/ORD` only

#### Scenario: A table that declares the keyword
- **WHEN** a company command file lists `TOLIB: library` in the `XYZCPY` entry's `params`
- **THEN** the same statement carries no warning, and `TOLIB`'s library is decided

#### Scenario: Command nested in SQL
- **WHEN** a script runs `CALL QSYS2.QCMDEXC('XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)')`
- **THEN** that SQL statement carries the warning naming `XYZCPY` and `TOLIB`

#### Scenario: Command that is danger
- **WHEN** a command not in the table, or one classed `danger`, is given any parameter
- **THEN** no warning is added for it
