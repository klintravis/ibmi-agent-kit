## Why

A live build in the user's own library was refused at `CRTBNDDIR`: the shipped CL command table
(`packages/guard/src/commands.yaml`) had no binding-directory commands, so the guard classed them
`danger` ("not in the command table"). Message-file commands and a few other everyday build
commands were missing the same way (T-68).

## What Changes

- Command table entries:
  - Binding directories: `CRTBNDDIR`, `DLTBNDDIR`, `ADDBNDDIRE`, `RMVBNDDIRE` as `ddl` on the
    directory, the objects an entry names as `read`; `DSPBNDDIR` (with `OUTFILE` written),
    `WRKBNDDIR`, `WRKBNDDIRE` as `read`.
  - Message files: `CRTMSGF`, `DLTMSGF`, `ADDMSGD`, `CHGMSGD`, `RMVMSGD` as `ddl`;
    `ADDMSGD`/`CHGMSGD` `DFTPGM(lib/pgm)` is `danger`, since that program runs later for whoever
    gets the message. `DSPMSGD`, `WRKMSGD`, `WRKMSGF` as `read`.
  - `CHGPGM`, `CHGSRVPGM` as `ddl`. `CRTSQLCI` as `compile`, like `CRTSQLRPGI`.
  - `TOSRCFILE` is written on `CRTSQLRPGI`, `CRTSQLCBLI` and `CRTSQLCI`.
- CL parsing: a list given by position, `(A B C)`, is classified like `KEYWORD(A B C)`. Before,
  `CHGLIBL (A B C)` classified only `A`.
- A build-script case in `examples/demo/observe.tests.yaml`; `docs/policy.md` states the coverage.

No MCP tools added or changed. Out of scope: `RTVBNDSRC` and `RTVCLSRC` (the source file they write
defaults to the library list, so naming only the read parameter would class them read-only),
`CLRDTAQ` (not confirmed as a QSYS command; a same-named command found through the library list
would be classed `write`), `STRDBG`, `STRSEU`, `SNDMSG`, the C++ compilers.

## Impact

`packages/guard/src/commands.yaml`, `packages/guard/src/cl.ts`, `packages/guard/src/selfcheck.ts`,
`examples/demo/observe.tests.yaml`, `docs/policy.md`, `docs/demo.md`.
