# Proposal

## Why

The demo today shows the guard deciding statements, the verbs and the config bootstrap, but never
the reason a developer would want the kit: an agent that builds a real ILE program from source,
proves it with unit tests and then drives its green screen while you watch. A first-time user should
see that in about ten minutes, straight after connecting and a short look at the guard, without
writing anything and without leaving objects behind.

## What Changes

- A small invented ILE sample app under `examples/showcase/`, a seed-stock list (prefix `SEED`):
  a keyed PF with 8 rows covering every stock status, a service program with three procedures
  (get, count, status rule), a prototype copy member, a DSPF with a subfile list and a detail
  screen (option 5, multi-select, F5 reload, F12, F3), the list program, and a unit-test program
  that ends with `SEEDTST: 9 passed, 0 failed`. Fixed-column DDS is shipped as is: no generator,
  no Python.
- Two Markdown screen tests in the `run_tests` format, one for the list and one for the detail.
  Both start and end on the list screen and name no library, so they run in the demo's open
  session against any library.
- Four verbs beside the demo policies (`examples/demo/verbs/`): `SEED-PREP` (fails on leftovers,
  creates the demo's own source file), `SEED-BUILD` (current library, PF, sample rows, DSPF,
  modules, service program, programs, unit tests), `SEED-ADDROW` (the live insert) and
  `SEED-CLEAN` (deletes exactly the objects the demo created, then checks none is left). The verbs
  are the build script: the guided part runs them with `verb_run`, and `policy test` decides every
  statement in them, so the steps the user runs and the steps the tests check cannot drift.
- Policy test cases for every showcase statement under both demo policies, in
  `examples/demo/showcase-observe.tests.yaml` and `examples/demo/showcase-enforce.tests.yaml`; the
  enforce file pins, statement by statement, which steps ask for confirmation.
- A new part "E. Build and watch" appended to `docs/demo.md`, and a matching section appended to the
  `/demo` skill: upload the sources into the user's library, build and run the unit tests, open a
  5250 session with the live viewer in the browser, drive the subfile (list, option 5,
  multi-select), run the screen tests, insert a row live and reload with F5, sign off, clean up.
  Expected results for each step, in observe and in enforce mode.
- The server selfcheck asserts the showcase sources and screen tests exist and parse, the members
  the build verb compiles are all shipped, the showcase cases pass under both demo policies, and
  the demo's upload and session tool calls are allowed for the owner on their library.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `demo-quickstart`: adds the showcase sample app, its build verbs and policy cases, its screen
  tests, and the guided "Build and watch" part with its selfcheck.

## Impact

- New files: `examples/showcase/src/*` (6 members), `examples/showcase/screen-tests/*.md` (2),
  `examples/demo/verbs/SEED-*.yaml` (4), `examples/demo/showcase-{observe,enforce}.tests.yaml`.
- Appended: `docs/demo.md` (part E), `.claude/skills/demo/SKILL.md` (one section).
- `packages/server/src/selfcheck.ts`: showcase tests next to the existing demo tests.
- No change to the guard, the command table, the tools, the profile format or the existing demo
  policies and test files. Live behavior on a real IBM i is checked by the desk, not by CI.
