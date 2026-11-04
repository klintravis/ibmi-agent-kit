# Proposal

## Why

After a fast or headless 5250 run a human cannot tell what the agent did or why at each screen: the
live view repaints and is gone, and the tool result holds only the last screen. A human should be able
to review the run afterwards, screen by screen, with the agent's reason for each key.

## What Changes

- `screen_do` and `run_tests` steps accept `note: <text>`. A note attaches to the next `key:` action in the
  same batch and becomes part of that step's label (`Enter: why`). It never reaches the host or the guard.
  A note with no key after it, or an empty note, is rejected before anything is sent.
- New profile setting `IBMI_5250_REPORT_DIR` (profile file only, optional). When set, each session writes
  one self-contained HTML file there: one block per step with number, time, label and the screen, and for
  `run_tests` a block per test with pass or fail and the failure messages. Plain HTML and CSS, no script,
  no external resource. Each step is appended as it happens, so a crash still leaves a readable report.
- A folder inside a git work tree is refused, and any write failure is a warning: a report never fails a
  session.
- `session_open` and `session_close` name the report file when one is being written.
- Stale text corrected: the host picks 24x80 or 27x132 per screen, so `session_open` no longer says
  "literal 24x80".

No breaking change. With the setting unset nothing is written and nothing else changes.

MCP tools, none added:

| Tool | Annotation (unchanged) | Change |
|---|---|---|
| `screen_do` | destructive | Accepts `note:` lines; description says to add one before each key |
| `run_tests` | destructive | Same lines in `5250-do` blocks; results recorded in the report |
| `session_open` | destructive | Result names the report path; description corrected |
| `session_close` | destructive | Result names the report path |

Out of scope:

- Size caps, rotation or deleting old reports: retention is the user's job.
- A report viewer, search index, or a report for the source (SQL) engine.
- Redacting data other than hidden fields: screens may show business data, and the report holds it.
- Setting the folder from the environment or a tool argument.
- Any viewer change: the viewer already shows the step label.

## Capabilities

### New Capabilities
- `screen-run-report`: the `note:` action and the per-session HTML run report.
