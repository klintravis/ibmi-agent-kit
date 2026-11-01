## ADDED Requirements

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
