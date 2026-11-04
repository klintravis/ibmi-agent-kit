# Design

## Context

Every key press in `screen_do` and `run_tests` goes through `applyActions`, which already does
`session.emit("step", label)`; the live viewer subscribes to it. Every session, including the one
`run_tests` opens, is created by `openSession` in `tools.ts`, so one subscription there covers all paths.
`frameOf` renders a screen to escaped HTML, and `ScreenBuffer.line` already blanks nondisplay fields.

## Decisions

### D1. `note:` is an action folded into the next key

`parseAction` returns `{ kind: "note" }` and refuses an empty one. `applyActions` first runs `checkNotes`, which
throws for a note with no key after it before the loop sends anything; the loop then keeps notes until the next key. `parseTest` runs the same
check per `5250-do` block, so `run_tests` fails before the first test starts. The step label is
`<key>: <note>`; the "stopped on an error" suffix is appended to that label. Failure messages still name the
key action alone.

### D2. The report is one append-only HTML file per session

`report-file.ts` exports `openReport(dir, server, session, warn)`, returning `undefined` when the setting is
unset, the folder is refused, or the file cannot be created. The file starts with the `<head>` and the shared
screen CSS and is never closed: browsers render an unclosed document. Each step is `appendFileSync` of a
`<section>`, so nothing is held in memory. The CSS is the viewer's, exported from `render.ts` as
`SCREEN_CSS`, not copied. A screen sits in a block with horizontal scroll so 132 columns do not break the
layout. No JavaScript, so browser find works and the page prints.

### D3. Wiring

`openSession` calls `openReport` when `profile.reportDir` is set, independent of `viewerEnabled`, and
subscribes to `step` and a new `test` event. `runTest` emits `test` with the name, outcome and failed check
messages once per test, so a test appears as a block after its steps. `session_open` and `session_close`
read the path from `OpenSession.report`.

### D4. Safety

- File name: `<UTC timestamp>_<server>_<session>.html`, server and session reduced to `[A-Za-z0-9_-]`, opened
  with flag `wx` (a counter is added on collision), so a name cannot leave the folder or overwrite a file.
- Mode 0600 on POSIX. On Windows the file inherits the folder's permissions (README says so).
- `gitWorkTree` from core refuses a folder inside a work tree: screens hold business data and a commit would
  publish them.
- Every string not already escaped by `frameOf` goes through one `esc`.
- Hidden fields are blank in `ScreenBuffer.line`; a selfcheck proves a typed hidden value is absent.
- `IBMI_5250_REPORT_DIR` joins core's protected settings, so the environment cannot redirect screens.

### D5. Known limit

`shortcut:` no size cap and no cleanup. A long headless run grows the file by one screen per step; upgrade to
a per-session cap or a retention setting if reports pile up.
