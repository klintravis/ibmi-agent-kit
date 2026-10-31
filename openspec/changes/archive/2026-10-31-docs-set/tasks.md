## 1. Docs

- [x] 1.1 READMEs for core, guard, server
- [x] 1.2 Root README: Tools table, Safety, package links
- [x] 1.3 `docs/policy.md`

## 2. Verify

- [x] 2.1 Docs updated (docs-check passes)
- [x] 2.2 check-names clean; `npm run clean && npm run check` passes

## 3. Review fixes

- [x] 3.1 Safety: per-tool checks named correctly; 5250 ignores `IBMI_READ_ONLY`
- [x] 3.2 Tools table: `compile_member` and `run_tests` change and run code; sorted by package then name; column note
- [x] 3.3 Always-denied wording and observe-mode note for unknown commands
- [x] 3.4 Registration env cannot override protected settings; `IBMI_KIT_CONFIG_DIR` picks the folder
- [x] 3.5 Guard reads policy, command and test files and appends the run log
- [x] 3.6 Run log path: first folder in `CONFIG_DIRS()`
- [x] 3.7 `policy` examples run via `node <repo>/packages/server/dist/index.js`
- [x] 3.8 Policy test example matches the shipped tests; `lookups.bases`
- [x] 3.9 Identity read once per server; reset job refuses later statements
- [x] 3.10 `SYSSCHEMAS` unverified; only `run_script` is confirmed and logged
- [x] 3.11 Policy guide "Turn it on": one `ini` block, Windows first
