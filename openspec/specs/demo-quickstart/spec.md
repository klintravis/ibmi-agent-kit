# demo-quickstart Specification

## Purpose
Lets a newcomer see the guard, verbs and config bootstrap work against their own IBM i in a few minutes, from a tested, ready-to-paste demo guide and a `/demo` skill.

## Requirements

### Requirement: Quick-start demo
The repository SHALL ship `docs/demo.md` and `examples/demo/` policies (observe and enforce) with
tests that pass under `policy test`, using placeholder names only.

#### Scenario: Demo policies stay valid
- **WHEN** `policy test` runs on each demo policy with its tests
- **THEN** it exits 0

### Requirement: Guided demo skill
The repository SHALL ship a `demo` skill that walks the user through `docs/demo.md` and never asks
for, reads or writes the profile password.

#### Scenario: Skill references stay real
- **WHEN** the selfcheck reads the skill
- **THEN** every tool name and repo path it names exists, and its connection query is read-only

### Requirement: The guided demo sets up the profile through setup
The `demo` skill and `docs/demo.md` SHALL have the user create the profile by running `setup <name>`
in their own terminal, never by editing the profile file and never through Claude. The skill SHALL
build that command from the kit path in `claude mcp get ibmi-agent-kit`, not ask or search for it.

#### Scenario: Profile step
- **WHEN** the skill reaches the profile step
- **THEN** it shows `node <kit>/packages/server/dist/index.js setup <name>` with `<kit>` taken from the registered server's arguments, and waits

### Requirement: The guided demo explains a hidden project server
The `demo` skill SHALL check `claude mcp get ibmi-agent-kit` before connecting and, for a pending,
rejected or disabled project server, tell the user the documented way to approve or re-enable it.

#### Scenario: Rejected server
- **WHEN** `claude mcp get ibmi-agent-kit` shows the server as rejected
- **THEN** the skill tells the user to run `claude mcp reset-project-choices` and restart `claude`, or remove the name from `disabledMcpjsonServers`

### Requirement: Registration env versus profile file is documented
`docs/demo.md` SHALL say that non-protected settings such as `IBMI_5250_VIEWER` may be set in the
MCP registration's env and that protected settings come only from the profile file.

#### Scenario: Live viewer setting
- **WHEN** a reader wants the live 5250 view in the demo
- **THEN** the guide shows `IBMI_5250_VIEWER=true` in the registration env and says `IBMI_5250_VIEWER_PORT` belongs in the profile

### Requirement: Showcase sample app
The kit SHALL ship a small ILE sample app under `examples/showcase/src/` with invented names only
(prefix `SEED`): a keyed physical file with 8 sample rows covering every stock status, a service
program with get, count and status-rule procedures, a prototype copy member, a display file with a
subfile list and a detail screen, the list program and a unit-test program. No member SHALL name a
library.

#### Scenario: Sources match the build
- **WHEN** the selfcheck reads the `SRCMBR(...)` values of the `SEED-BUILD` verb
- **THEN** each one, and the copy member `SEEDPR`, has a file in `examples/showcase/src/`

#### Scenario: List screen keys
- **WHEN** the list program runs
- **THEN** option 5 on one or more rows shows the detail screen for each in turn, F12 returns, F5 reloads from the file and F3 ends the program

### Requirement: Showcase DDS is shipped as fixed-column source
The physical file and display file members SHALL be committed as fixed-column DDS, with no
generator script and no Python.

#### Scenario: DDS columns
- **WHEN** the selfcheck reads the PF and DSPF members
- **THEN** every non-comment line has `A` in column 6 and no line is longer than 80 characters

### Requirement: Showcase unit tests report their result
The unit-test program SHALL send `SEEDTST: 9 passed, 0 failed` as a completion message when every
assertion holds, and otherwise end with an escape message that names each failed assertion.

#### Scenario: A failing unit test fails the build
- **WHEN** an assertion fails while `SEED-BUILD` calls the unit-test program
- **THEN** the `CALL` step fails with the failed assertion's name and the verb stops there

### Requirement: Showcase build verbs
The demo SHALL ship verbs `SEED-PREP`, `SEED-BUILD`, `SEED-ADDROW` and `SEED-CLEAN` in
`examples/demo/verbs/` as the single build script read by both the guided part and the policy
tests. Each SHALL take a `lib` parameter limited by an `allowed` list to the user's library,
qualify every object with it, and create objects only in `steps`, never in `setup`. No verb SHALL
touch QGPL.

#### Scenario: Build order
- **WHEN** `SEED-BUILD` runs after `SEED-PREP` and the uploads
- **THEN** it creates the physical file and its rows, the display file, the modules, the service program, the programs with CRTPGM BNDSRVPGM, and then calls the unit-test program

#### Scenario: Leftovers stop the prep
- **WHEN** `SEED-PREP` runs and an object named in the demo's list exists in the library
- **THEN** the verb fails at its first step and creates nothing

### Requirement: Showcase cleanup deletes only what the demo created
`SEED-CLEAN` SHALL delete exactly the objects the showcase creates and end with a check that none of
them is left.

#### Scenario: Clean after a full build
- **WHEN** `SEED-CLEAN` runs after a full build
- **THEN** it deletes the demo's programs, service program, modules, display file, physical file and source file, its final check finds none of them, and no other object is touched

### Requirement: Showcase policy cases
`examples/demo/showcase-observe.tests.yaml` and `examples/demo/showcase-enforce.tests.yaml` SHALL
decide every SQL statement and CL command the guided part sends: one verb case per showcase verb
and a script case for the program call the session types on its command line. In the enforce file each verb case SHALL give one
decision per statement.

#### Scenario: Showcase cases pass
- **WHEN** the selfcheck runs `policy test` on each demo policy with its showcase test file
- **THEN** every case passes and the command exits 0

#### Scenario: Enforce pins the confirmations
- **WHEN** the enforce case for `SEED-BUILD` is decided
- **THEN** the physical-file create is `confirm` and every compile, the library-list change, the inserts, the checks and the test call are `allow`

### Requirement: Showcase tool calls are allowed for the owner
The selfcheck SHALL decide the guided part's `upload_source_member`, `session_open` and
command-line `CALL` under both demo policies and expect `allow`.

#### Scenario: Upload and session decided
- **WHEN** the selfcheck decides an `upload_source_member` into `MYLIB/SEEDSRC`, a `session_open` with library `MYLIB` and no program, and the command line `CALL MYLIB/SEEDLST` for `MYUSER`
- **THEN** both demo policies decide `allow` for each

### Requirement: Showcase screen tests
The kit SHALL ship Markdown screen tests in the `run_tests` format under
`examples/showcase/screen-tests/`, one for the list and one for the detail screen. Each SHALL
start and end on the list screen, type no command and name no library.

#### Scenario: Screen tests parse and stay library-free
- **WHEN** the selfcheck parses each screen test with the screen package's test parser
- **THEN** it parses without error and its text contains no `CALL` and no `MYLIB`

### Requirement: Build and watch guided part
`docs/demo.md` SHALL end with a part "E. Build and watch" that needs only Setup and part A, works
under either demo policy and gives an Expected result per step: prep, upload into the user's
library, build with the unit-test result, a 5250 session with the live viewer open in the browser,
list, option 5 and multi-select, the screen tests, a live insert with F5, sign-off and cleanup.

#### Scenario: Viewer setting
- **WHEN** the reader's `.mcp.json` lacks the viewer setting
- **THEN** part E says to add `IBMI_5250_VIEWER=true` to the demo folder's `.mcp.json` env, never to the profile, and restart the server

#### Scenario: Live row appears after reload
- **WHEN** the user runs `SEED-ADDROW` with the list open and presses F5
- **THEN** the guide's Expected line says the new row is listed and the footer reads `9 seeds.`

#### Scenario: Enforce and recovery
- **WHEN** the reader runs part E under the enforce policy or the build stops halfway
- **THEN** the part says which verbs ask one confirmation and how to delete what a partial build left

### Requirement: Demo skill walks Build and watch
The `demo` skill SHALL have an appended section that walks part E, naming verbs, tools and paths
only, never the statements themselves.

#### Scenario: Skill references stay real
- **WHEN** the selfcheck checks the demo skill with the appended section
- **THEN** every tool name and repo path in it exists and the skill contains no CREATE, DROP or INSERT
