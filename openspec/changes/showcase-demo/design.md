# Design

## Context

- `docs/demo.md` has Setup (profile, `.mcp.json`, SMOKE-SAMPLE verb) and parts A (observe),
  B (enforce), C (verbs), D (config bootstrap), then Clean up. The `/demo` skill walks it.
- The demo policies (`examples/demo/policy-{observe,enforce}.yaml`) allow the owner `MYUSER`
  everything on `MYLIB` except danger; enforce adds `confirm` for the owner's DDL on `MYLIB`.
  Unqualified objects are denied in every mode.
- Command classes (`packages/guard/src/commands.yaml`): CRTSRCPF, CRTPF and every DLT* are `ddl`;
  CRTRPGMOD, CRTSRVPGM, CRTPGM, CRTDSPF are `compile`; CHGCURLIB is `liblist`; CALL is `call`.
  So in enforce mode only the DDL asks, once per `verb_run`.
- Verbs (`docs/verbs.md`): setup / steps / cleanup; cleanup always undoes a successful setup at the
  end of the run; steps stop at the first failure; `${lib}` text substitution needs an `allowed`
  list; a step `expect {sql, empty|rows|equals}` must be a read. `policy test` finds verbs in
  `<cwd>/.ibmi-kit/verbs` and in `verbs/` beside the policy (org layer); the server finds the same
  org layer beside the profile's policy.
- `upload_source_member` creates a missing member (`create: true`) but not the source file.
  `session_open` decides its program as `CALL PGM(lib/pgm)`, so a qualified program is needed.
  `run_tests` reuses an open session with `session`; screen tests have no variables.
- The selfcheck "demo skill" test refuses `CREATE`, `DROP` or `INSERT` anywhere in the skill text
  and checks every backticked tool name and repo path in it.
- A parallel change (`team-onboarding`) edits `docs/demo.md` and the skill. `first-run` (merged,
  not archived) also has a `demo-quickstart` delta.

## Goals / Non-Goals

**Goals:**

- A ten-minute "see the power" part a first-time user runs right after Setup and part A.
- Everything the demo sends to the box is in files the tests read, so docs and tests cannot drift.
- Cleanup removes exactly the objects the demo created, and fails loudly if any remain.

**Non-Goals:**

- No new tool, verb feature, command table entry or policy rule.
- No live check in CI; no PUB400-specific steps.
- No generator or Python for the DDS; no build system (no Makefile, no Bob, no `iproj.json`).
- No change to the existing demo test files or their `N cases passed` lines.

## Decisions

### D1. The build script is four verbs, not a new data format

`examples/demo/verbs/SEED-{PREP,BUILD,ADDROW,CLEAN}.yaml`, org layer beside the demo policies.
The user already copies `examples/demo/` into the demo folder (Setup step 1), so the verbs come
along and the server finds them beside the profile's policy; `policy test` finds them the same way,
in the user's copy and in the selfcheck. A verb case in a test file decides every statement the
verb would send, the same planning `verb_run` uses. Alternatives: a new `build.yaml` read by the
skill and a new test (new format and parser for nothing); the proj layer `.ibmi-kit/verbs`
(the policy CLI reads it only from its cwd, so the selfcheck would need a temp folder).

Each verb has `params.lib: { type: string, default: MYLIB, allowed: [MYLIB] }`, like SMOKE-SAMPLE,
tag `showcase`, and puts every create in `steps`, never in `setup` (a setup's cleanup would delete
the work at the end of the same run). One statement per entry.

- `SEED-PREP`: `expect empty` over `TABLE(QSYS2.OBJECT_STATISTICS('${lib}', '*ALL'))` filtered to
  the demo's object names (a catalog table function in FROM is a read), then
  `CRTSRCPF FILE(${lib}/SEEDSRC) RCDLEN(112)`. A leftover from an earlier run fails the first step
  with nothing changed; the part says to run `SEED-CLEAN` and try again.
- `SEED-BUILD`: `CHGCURLIB CURLIB(${lib})`, `CRTPF FILE(${lib}/SEEDS) SRCFILE(${lib}/SEEDSRC) SRCMBR(SEEDS)`,
  one multi-row `INSERT INTO ${lib}.SEEDS ...` of the 8 sample rows, `expect rows: 8`,
  `CRTDSPF`, `CRTRPGMOD` for SEEDSRV, SEEDLST and SEEDTST, `CRTSRVPGM SRVPGM(${lib}/SEEDSRV)
  MODULE(${lib}/SEEDSRV) EXPORT(*ALL)`, `CRTPGM` for SEEDLST and SEEDTST with
  `BNDSRVPGM((${lib}/SEEDSRV))`, SEEDLST in `ACTGRP(SEEDDEMO)` and SEEDTST in `ACTGRP(*NEW)` so
  nothing stays active in the kit's SQL job and SEED-CLEAN can delete it (CRTRPGMOD + CRTPGM
  BNDSRVPGM, as in the reference build), and last
  `CALL PGM(${lib}/SEEDTST)`. CHGCURLIB (idempotent, unlike ADDLIBLE) puts the library in the job's
  library list, so `/copy SEEDSRC,SEEDPR` and the `dcl-f` names resolve and no source file names a
  library.
- `SEED-ADDROW`: one `INSERT` of row 9, then `expect rows: 9`.
- `SEED-CLEAN`: `DLTPGM` SEEDLST and SEEDTST, `DLTSRVPGM` SEEDSRV, `DLTMOD` SEEDSRV, SEEDLST and
  SEEDTST, `DLTF` SEEDDSPF, SEEDS and SEEDSRC, then the same `expect empty` as PREP. Only these
  names, always qualified with `${lib}`.

Names avoid the words CREATE, DROP and INSERT, so the skill can name them (selfcheck rule above).

### D2. A demo-owned source file instead of "create QRPGLESRC if missing"

All six members go into one file the demo creates, `SEEDSRC` (RCDLEN 112 holds DDS and free RPG),
and `SEED-CLEAN` deletes it. Writing into the user's QRPGLESRC/QDDSSRC would mean either leaving
members behind or deleting a file the user may have owned before, and telling the two apart needs
state the demo does not keep. With an own file, "delete only what the demo created" is a fixed list
of names. Never QGPL: every object is `${lib}/...` and `lib` only allows the user's library.

### D3. Fixed-column DDS shipped directly; no `gen/dds.py`

The PF and DSPF members are committed as fixed-column DDS text (A in column 6, conditioning 7-16,
type at 17, name at 19, length right-aligned ending at 34, data type 35, decimals 36-37, usage 38,
line 39-41, position 42-44, keywords from 45). The generator in the reference only placed columns;
two small members do not need it, and the kit stays Node-only. The selfcheck checks the column
layout cheaply (every non-comment line has `A` in column 6 and no line is longer than 80).
Sources are LF in the repo (`.gitattributes`); `upload_source_member` writes lines, not bytes.

### D4. The sample app

Invented domain and names only: a seed-stock list, prefix `SEED`.

| Object | Type | What |
|---|---|---|
| `SEEDSRC` | *FILE (source PF) | holds the six members |
| `SEEDS` | *FILE (PF), format `SEEDREC` | `SEEDID` 5P0 key (UNIQUE), `SEEDNAME` 30A, `SEEDQTY` 7P0 |
| `SEEDPR` | copy member | prototypes and the `SEEDREC`-like data structure |
| `SEEDSRV` | *MODULE, *SRVPGM | `SeedGet(id: ds) ind`, `SeedCount() int`, `SeedStatus(qty) varchar(10)` |
| `SEEDDSPF` | *FILE (DSPF) | `SEEDSFL`/`SEEDCTL` subfile list, `SEEDFTR` footer, `SEEDDTL` detail |
| `SEEDLST` | *MODULE, *PGM | the list program |
| `SEEDTST` | *MODULE, *PGM | unit tests |

Status rule (`SeedStatus`): 0 is `Sold out`, 1 to 24 `Low`, 25 to 500 `In stock`, above 500
`Overstock`. Sample rows: 1 Sunflower 0, 2 Basil 12, 3 Tomato 240, 4 Sweet pea 0, 5 Lavender 24,
6 Carrot 500, 7 Zinnia 75, 8 Kale 900 (two Sold out, two Low, three In stock, one Overstock;
the boundaries 24 and 500 are rows). The live row: 9 Marigold 40.

Screens: list title `Seed Stock List`, legend `5=Display`, columns Opt / ID / Name / Qty / Status,
`Bottom` at the end of the subfile, footer `8 seeds.` and `F3=Exit  F5=Refresh`; the option field
of the first row takes the cursor. Option 5 on one or more rows shows `Seed Detail` for each in turn
(Enter or F12 moves on), then the list again. F5 reloads from the file. F3 ends the program.

Unit tests (`SEEDTST`), 9: `SeedStatus` at 0, 1, 24, 25, 500, 501; `SeedGet(3)` finds Tomato;
`SeedGet(99)` finds nothing; `SeedCount()` is 8. It sends a completion message
`SEEDTST: 9 passed, 0 failed` to its caller, or an escape message `SEEDTST: n passed, m failed.
Failed: <names>`, so a failed assertion fails the `CALL` step and stops `SEED-BUILD`.

### D5. Screen tests run inside the demo's own session

`examples/showcase/screen-tests/01-list.md` and `02-detail.md` start on the list screen and end on
it, type no command and name no library. The guided part opens the session with
`session_open(library: "MYLIB")`, no program: the standard sign-on screen's Program/procedure
field takes 10 characters and no library, so `MYLIB/SEEDLST` cannot go there. `screen_do` then
types `CALL MYLIB/SEEDLST` on the command line and presses Enter (the path the reference proved
live; the guard decides the line before it is sent, qualified, so it is allowed). F3 ends the
program and returns to that command line, so `session_close` signs off normally. The guided part
runs `run_tests` with the absolute path of the folder and `session` set, before the live insert,
so `8 seeds.` holds. Alternative: tests that type the `CALL` themselves, as the reference did;
they would bake a library into shipped files and could not run as is.

### D6. Policy cases in two new test files beside the demo policies

`examples/demo/showcase-observe.tests.yaml` and `showcase-enforce.tests.yaml`: one verb case per
showcase verb (`verb: SEED-BUILD, args: { lib: MYLIB }`) and script cases for what the part sends
outside verbs (`CL: CALL PGM(MYLIB/SEEDLST)`, the session's command-line call). Observe expects `allow`;
enforce gives the per-statement array, so the confirm steps (CRTSRCPF, CRTPF, each DLT*) are
pinned and the part can say exactly what asks. New files, rather than new cases in
`observe.tests.yaml` / `enforce.tests.yaml`, keep Setup step 1's `5 cases passed` true and keep
this change clear of the lines the parallel onboarding change edits.

The tool calls (`upload_source_member` into `MYLIB/SEEDSRC`, `session_open` with `library: MYLIB`)
are not statements a test file can hold; the selfcheck decides them with `toolStatements` and both
demo policies and expects `allow`.

### D7. The guided part is appended, but runs right after part A

`docs/demo.md` gets `## E. Build and watch (about 10 minutes)` appended at the end of the file,
so a rebase on the onboarding change touches only the end. Being last on the page does not make it
last in the run: its first lines say it needs only Setup and part A, can run right after A (before
B, C, D), works in either policy mode, and has its own clean-up step, so the doc's Clean up section
is not needed for it. It covers, with an Expected line each:

1. Viewer: if Setup step 3 left out `"env": { "IBMI_5250_VIEWER": "true" }`, add it to the demo
   folder's `.mcp.json`. Never in the profile.
2. Library: replace `MYLIB` and `MYUSER` in the copied `demo/verbs/SEED-*.yaml` and the two
   showcase test files; optional `policy test` check of the showcase files. Then restart the
   server once (`/mcp`): it reads a server's verbs once and caches them, and the viewer setting is
   read at start too.
3. `verb_run SEED-PREP` (enforce: one question for CRTSRCPF).
4. `upload_source_member` six times, `create: true`, `localPath` `<kit>/examples/showcase/src/...`.
5. `verb_run SEED-BUILD`. Expected: passes; the CALL step shows `SEEDTST: 9 passed, 0 failed`
   (enforce: one question for CRTPF). A compile failure names the member; `compile_member` on that
   member shows the compiler's messages.
6. `session_open` and the command-line `CALL` as in D5; open the `Live view:` URL in a browser.
7. `screen_do` / `screen_snapshot`: the list with 8 rows, option 5 on Tomato (`In stock`), F12,
   option 5 on Basil and Kale, Enter through both details.
8. `run_tests` on `<kit>/examples/showcase/screen-tests` with the session. Expected: 2 passed.
9. `verb_run SEED-ADDROW`, then F5 in the session. Expected: Marigold appears, `9 seeds.`.
10. F3 (back to the command line), `session_close` (signs off cleanly).
11. `verb_run SEED-CLEAN` (enforce: one question for all DLT*). Expected: passes, ending on the
    empty check. If BUILD stopped halfway, CLEAN stops at the first missing object: list the
    remaining names with the PREP query (`run_sql`) and delete those with the matching lines of
    `SEED-CLEAN.yaml` via `run_script`, then run `SEED-CLEAN`'s check again.

The skill gets one appended section that walks part E the same way and opens the URL with the
platform's opener (`start` / `open` / `xdg-open`). It names verbs, tools and paths only; the
statements stay in the verb files (the skill may not contain CREATE, DROP or INSERT).

### D8. Selfcheck

Next to the existing demo tests in `packages/server/src/selfcheck.ts`:

- every `SRCMBR(...)` in `SEED-BUILD.yaml`, plus the copy member `SEEDPR`, has a file in
  `examples/showcase/src/`; the DDS members pass the column check of D3;
- both screen tests parse with `parseTest` (imported from `../../screen/dist/testrun.js` by URL,
  as the demo test imports `source/dist/util.js`) and contain no library name or `CALL`;
- `policy test` passes for both demo policies with their showcase test files (the existing
  `runBin` helper);
- `toolStatements` for the demo's `upload_source_member` and `session_open` calls decides `allow`
  under both demo policies;
- the existing demo-skill test keeps covering the appended section's tool names and paths.

## Risks / Trade-offs

- Not verified live: whether a DDS PF in a non-journaled library takes the SQL `INSERT` under the
  kit's JDBC defaults (autocommit runs with no commitment control, so it should); whether the
  completion message text of a CALL reaches the `verb_run` outcome. The escape message still fails
  the step, so a failing test is never reported as a pass. The desk checks both live before merge.
- `CHGCURLIB` changes the current library of the kit's SQL job for the rest of the server's life.
  Unqualified names are denied by the guard anyway, so it changes no decision; the part says so.
- Org-layer verbs show up in part C's `verb_list` next to SMOKE-SAMPLE. Part C's expected line
  stays true (SMOKE-SAMPLE is listed); part E mentions the extra verbs.
- A partial build needs the manual recovery in D7 step 11; verbs have no "ignore if missing".
- Rebase: part E and the skill section are appended; the onboarding change may move the text above
  them, but no existing line is edited by this change.

## Open questions

1. **Demo-owned source file instead of "create QRPGLESRC/QDDSSRC if missing".** The task asked for
   source files created if missing; this design always creates and deletes its own `SEEDSRC` and
   refuses to start over leftovers. Recommendation: keep the own file (D2); it is the only way to
   delete exactly what the demo created without tracking state.
2. **Showcase cases in new test files instead of the existing `observe.tests.yaml` /
   `enforce.tests.yaml`.** Recommendation: new files (D6); same coverage, same selfcheck, no
   change to Setup step 1's count, no conflict with the onboarding change.
3. **Confirmations in enforce mode.** PREP, BUILD and CLEAN each ask one question (their DDL).
   Recommendation: keep it; it is part of what the demo shows. Running part E under observe asks
   nothing.
4. **Live verification.** CI cannot run the build. Recommendation: before merge the desk runs part
   E once against its test box (one session, no retries) and records the observed outputs in the
   doc's Expected lines.
