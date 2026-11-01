# Tasks

Names, statements and expected texts are fixed in design.md (D1, D4); keep them exact, the screen
tests and docs quote them. Selfcheck tests go in `packages/server/src/selfcheck.ts` next to
"policy test: both demo policies pass their tests". Check after each group:
`npm run clean && npm run check` exits 0.

## 1. Build verbs and policy cases

- [x] 1.1 Write `examples/demo/verbs/SEED-PREP.yaml`, `SEED-BUILD.yaml`, `SEED-ADDROW.yaml` and `SEED-CLEAN.yaml` as in design D1 (`lib` param with `allowed: [MYLIB]`, tag `showcase`, creates only in `steps`, one statement per entry, every object `${lib}/...`, names free of the words CREATE/DROP/INSERT); verify each loads without a warning from `policy test` (task 1.3)
- [x] 1.2 Write `examples/demo/showcase-observe.tests.yaml` (each verb with `args: { lib: MYLIB }` expecting `allow`, plus a script case `CL: CALL PGM(MYLIB/SEEDLST)`) and `showcase-enforce.tests.yaml` (same cases; verb cases as per-statement arrays: confirm on CRTSRCPF, CRTPF and each DLT*, allow elsewhere); verify `node packages/server/dist/index.js policy test examples/demo/policy-<mode>.yaml examples/demo/showcase-<mode>.tests.yaml` passes for both modes
- [x] 1.3 Add a selfcheck test that runs `policy test` for both demo policies with their showcase test files (exit 0, no `warning:` on stderr), and one that decides `toolStatements` for `upload_source_member` into `MYLIB/SEEDSRC` and `session_open` of `MYLIB/SEEDLST` with `library: MYLIB` as `MYUSER` under both demo policies and expects `allow`; verify both pass and fail when a verb statement is made unqualified

## 2. Sample app sources

- [x] 2.1 Write `examples/showcase/src/SEEDS.pf` and `SEEDDSPF.dspf` in fixed-column DDS (design D3, D4: format `SEEDREC`, UNIQUE key `SEEDID`; `SEEDSFL`/`SEEDCTL`/`SEEDFTR`/`SEEDDTL`, texts `Seed Stock List`, `5=Display`, `Seed Detail`, `F3=Exit  F5=Refresh`, CA03/CA05/CA12, option field VALUES(' ' '5')), LF line endings; verify by the column check in 2.4
- [x] 2.2 Write `SEEDPR.rpgle` (prototypes, data structure) and `SEEDSRV.rpgle` (`SeedGet`, `SeedCount`, `SeedStatus` with the D4 thresholds), fully free RPG, `/copy SEEDSRC,SEEDPR` unqualified, no library names; verify by review against D4 and the source check in 2.4
- [x] 2.3 Write `SEEDLST.rpgle` (load subfile, footer `<n> seeds.`, option 5 on each selected row shows `SEEDDTL` in turn, F12 or Enter moves on, F5 reloads, F3 ends) and `SEEDTST.rpgle` (the 9 assertions of D4; completion message `SEEDTST: 9 passed, 0 failed`, or an escape message listing failures after `Failed:` via QMHSNDPM); verify by review against D4
- [x] 2.4 Add a selfcheck test: every `SRCMBR(...)` in `SEED-BUILD.yaml`, plus `SEEDPR`, has a file in `examples/showcase/src/`; every non-comment line of the `.pf` and `.dspf` members has `A` in column 6 and is at most 80 characters; no member contains `MYLIB` or `QGPL`; verify it passes, and fails when a member file is renamed

## 3. Screen tests

- [x] 3.1 Write `examples/showcase/screen-tests/01-list.md` (expects `Seed Stock List`, `5=Display`, rows, `Bottom`, `8 seeds.`, cursor on the first option field; F5 and the same expectations) and `02-detail.md` (option 5 on Tomato shows `Seed Detail` and `In stock`, F12 back; option 5 on Basil and Kale, Enter through both details back to the list); both start and end on the list, no command typed, no library; verify with 3.2
- [x] 3.2 Add a selfcheck test that parses each screen test with `parseTest` (dynamic import of `../../screen/dist/testrun.js` by URL, as the demo test imports `source/dist/util.js`) and asserts the text has no `CALL` and no `MYLIB`; verify it passes, and fails on a malformed `5250-do` line

## 4. Guided part and skill

- [ ] 4.1 Append `## E. Build and watch (about 10 minutes)` to `docs/demo.md` after the last section, editing no existing line: needs only Setup and part A, either policy mode, its own clean-up; the eleven steps of design D7 with an Expected line each (one server restart after the viewer setting and the verb edits, since verbs are cached per server; unit-test line, `Live view:` URL, the screens, `2 passed`, `9 seeds.`, the confirmations in enforce, partial-build recovery, the extra verbs in part C's `verb_list`, CHGCURLIB leaving the SQL job's current library set); verify the desk's docs check (`node C:/IbmiKit/Source/desk/scripts/docs-check.mjs .`, also run by finish-worktree) passes and every path it names exists
- [ ] 4.2 Append one section to `.claude/skills/demo/SKILL.md` that walks part E: library substitution in the copied `demo/verbs/SEED-*.yaml` and showcase test files, `verb_run`, the restart, `upload_source_member` with each file of `examples/showcase/src/` (write the folder with its trailing slash or the six file names, never a `...` placeholder: backticked paths are checked with `existsSync`), `session_open`, opening the URL (`start` / `open` / `xdg-open`), `screen_do`, `screen_snapshot`, `run_tests` with the absolute path and `session`, `session_close`; names verbs, tools and paths only, never CREATE, DROP or INSERT, and adds no SELECT before the existing connection query; verify the existing "demo skill" selfcheck test passes

## 5. Integration checks

- [ ] 5.1 `npm run clean && npm run check` exits 0 and `node scripts/check-names.mjs` passes
- [ ] 5.2 `openspec validate showcase-demo --strict` passes

## Workflow follow-up

- Live run of part E against the desk's test box (one session, no retries), recording the observed outputs in the Expected lines (design, open question 4).
- Archive the change after review and merge.
