## 1. Command table

- [x] 1.1 Add the binding-directory, message-file, `CHGPGM`/`CHGSRVPGM` and `CRTSQLCI` entries; `DFTPGM` as `danger`; `TOSRCFILE` written on `CRTSQL*`
- [x] 1.2 A list given by position is classified like the keyword form
- [x] 1.3 Selfcheck: class of each new entry, nested `ADDBNDDIRE` list, `DFTPGM(*NONE)` and `DFTPGM(B/P)`, positional `CHGLIBL` and `RUNSQL` lists

## 2. Demo and docs

- [x] 2.1 Build-script case in `examples/demo/observe.tests.yaml` (5 cases pass)
- [x] 2.2 `docs/policy.md` coverage paragraph, `docs/demo.md` case count; docs-check passes

## 3. Verify

- [x] 3.1 `npm run clean && npm run check` passes; check-names clean
