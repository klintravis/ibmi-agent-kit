# Verbs

A verb is a named, parameterised IBM i procedure, such as a smoke test, kept as one YAML file and
run with `verb_run` through the same execution guard as `run_script`.

People keep their own verbs; teams keep shared ones in the application repo and review them like
code. A verb runs with the signed-on user's own policy rules and IBM i authority, so sharing one
grants nothing. Verbs are files a person writes: no tool creates, changes or deletes them.

Status: the runner and the tools are checked with stub connections only; no verb has run on a
live IBM i yet.

## A verb file

Every name below is invented.

```yaml
name: SMOKE-ORDERS
description: Order validation still accepts a new order
tags: [smoke]
params:
  env:   { type: string, default: IN1, allowed: [IN1, IN2] }
  order: { type: integer, default: 999001 }
setup:
  - id: seed
    requires_absent: "SELECT 1 FROM ORD${env}.ORDHDR WHERE OHORD = :order"
    sql: "INSERT INTO ORD${env}.ORDHDR (OHORD, OHCUS) VALUES (:order, 'TEST01')"
steps:
  - cl: "CALL PGM(ORD${env}/ORDVAL) PARM('${order}')"
  - expect:
      sql: "SELECT OHSTS FROM ORD${env}.ORDHDR WHERE OHORD = :order"
      equals: { OHSTS: V }
cleanup:
  - undoes: seed
    sql: "DELETE FROM ORD${env}.ORDHDR WHERE OHORD = :order"
```

| Key | What |
|---|---|
| `name` | Letters, digits, `_` and `-`; matched in any case. |
| `description` | One line, shown by `verb_list`. |
| `tags` | Optional; `verb_run` with `tag` runs every verb carrying it. |
| `params` | Optional; each has a `type` (`string`, `integer`, `decimal`, `date` as `YYYY-MM-DD`, `boolean`) and may have `default`, `allowed` and `required`. Every parameter needs a value, from the call or its default. |
| `setup` | Statements that create test data: one `sql` or `cl` each, an optional `id`, and an optional `requires_absent` query. |
| `steps` | At least one: `sql`, `cl`, `expect`, or `verb` (another verb, with `args`). |
| `cleanup` | Each entry names the setup `id` it `undoes` and gives one `sql` or `cl`. |

A key the format does not know (for example `step:` for `steps:`) refuses the file, naming the key;
other verbs still load. One SQL statement per entry: no `;` between statements.

## Parameters: `:p` and `${p}`

- `:p` in SQL becomes a `?` marker and the value is sent bound, never spliced into the text. Use it
  for any value, including free text.
- `${p}` is text substitution, for names such as a library suffix. It is allowed only for a
  parameter with an `allowed` list or of type `integer`, `decimal`, `date` or `boolean`, and the
  value is checked before it is put in. A string parameter without `allowed` in `${p}` refuses the
  verb at load, as does `${p}` inside a comment; a bare `?` marker is refused too (write `:name`).
  Inside a quoted literal, quotes in the value are doubled. CL has no bound values, so CL uses
  `'${p}'`.
- A value outside `allowed`, or not of the parameter's type, fails the call before anything is sent.

## Layers

| Layer | Folder | For |
|---|---|---|
| `user` | `~/.ibmi-agent-kit/verbs` | one person's own verbs |
| `proj` | `.ibmi-kit/verbs` in the server's working folder, and each folder in the profile's `IBMI_KIT_VERBS` | a project's verbs, reviewed in its repo |
| `org` | `verbs/` beside the profile's `IBMI_KIT_POLICY` file | a company's verbs, next to its policy |

- Address a verb as `user:NAME`, `proj:NAME` or `org:NAME`. A bare `NAME` runs the closest layer
  that has it (`user`, then `proj`, then `org`), so a person can try a variant of a team verb
  without editing the shared file. `verb_list` marks the verb that is hidden as overridden. If the
  closest one was refused at load, a bare name fails rather than falling through to the next layer.
- Two files declaring the same name in one layer are both refused, naming both files.
- `IBMI_KIT_VERBS` is read from the profile file only, never from the environment. Its folders are
  separated by `;` on Windows and `:` elsewhere and must be absolute paths; a relative one is
  refused.

```ini
# %USERPROFILE%\.ibmi-agent-kit\.env.pub400   (Linux and macOS: ~/.ibmi-agent-kit/.env.pub400)
IBMI_KIT_VERBS=C:\work\shared-verbs
# Linux and macOS: IBMI_KIT_VERBS=/home/me/shared-verbs
```

A server's verbs load once, on its first verb tool call, and are not reloaded: restart the server
after editing a verb file. Keep verb folders, like the policy and the profile, out of the agent's
reach with your client's permission rules.

## Nested verbs

A `verb` step calls another verb by address with `args`. An arg that is exactly `${p}` passes the
caller's typed value; other text has `${}` substituted. Loading refuses a call to a missing or
refused verb, a missing or unknown argument, a type mismatch, any cycle (naming it), and a chain
of more than 5 verbs, the top one counted.

## How a run is decided

Before anything is sent, `verb_run` binds and substitutes every statement of the call: setup,
steps, nested verbs and cleanup, and for a suite every verb, then classifies them as one script in
run order and decides each one for the signed-on user, server and partition. Deciding them
together means one verb cannot set up a way past the guard for the next: a `QTEMP` alias created
earlier is decided as its base table.

- A statement the policy denies in effect runs nothing of its verb. In enforce mode that is every
  deny; in observe mode only `danger`, `unqualified` and partition-conflict operations are denied,
  and other denies run and are logged (see [Modes](policy.md#modes)).
- The profile's own checks refuse in every mode, as for `run_script`: `IBMI_READ_ONLY` (only SQL
  reads run), `IBMI_BLOCKED_TABLES`, `IBMI_BLOCKED_CL`, and the runaway-query check.
- A `requires_absent` or `expect` query must only read. One the classifier finds doing more, for
  example `SELECT * FROM OLD TABLE (DELETE ...)`, is refused in every mode.
- Every statement a rule asks to confirm goes into one question for the whole call (see
  [Confirmation](policy.md#confirmation)). A decline, a client without elicitation or a timeout
  runs no verb of the call. If a decision read the current library, it is read again after the
  answer, and a change runs nothing.

## Running

1. Setup, in order. Each `requires_absent` query runs just before its own setup statement; if it
   returns a row the verb fails there, so a verb never overwrites, and later deletes, data it did
   not create. Setup that already succeeded is still cleaned up.
2. Steps, in order, stopping at the first failure. A nested verb runs its own setup, steps and
   cleanup in place. An `expect` checks `equals` (values in the first row), `rows` (a row count)
   or `empty`; one that does not hold fails the verb, reporting expected and found values, and
   later steps do not run. Trailing blanks of a CHAR value are ignored, and a numeric string
   matches the same number.
3. Cleanup: each entry whose `undoes` setup succeeded, even when a step failed. A failed cleanup
   entry does not stop the next; each is reported, and a failed cleanup fails the verb.

Queries (SELECT, VALUES, WITH), including `requires_absent` and `expect`, have the same time limit
as `run_sql`. Every statement and its outcome go to the run log as one call, with each verb's
layer and file (see [Run log](../packages/guard/README.md#run-log)).

### Connection reset

Every send carries the IBM i job the call was decided against. After a reset (a lost connection,
or the time limit, which resets the session) nothing more is sent, on the old job or a new one:
not the rest of the verb, not its cleanup, and no later verb. The result says "connection reset;
nothing more was sent; cleanup not run:" and lists the cleanup statements, to run by hand. A lost
connection may show only at the next send, which is refused before anything is sent.

## Suites

`verb_run` with `tag` runs every verb carrying the tag in address order, each with its defaults,
and reports passed, failed and skipped counts with each verb's statements.

- A verb with a parameter that has no default is skipped, naming the parameter.
- A verb a closer layer overrides is skipped: a bare name never reaches it.
- Later verbs are decided as if every earlier one ran in full, so once a verb is refused, finds
  its test data present, fails or stops early, no later verb is sent; each is reported "not sent:
  an earlier verb in this call did not run in full". The failing verb's own cleanup still runs.

## Check a verb before running it

- `policy_check` with `verb` and `args` returns each statement's operations, matching rule and
  decision, and runs nothing; only the catalog lookups needed to decide are sent. With `as` (and
  optionally `policy`) it decides offline and sends nothing. A `requires_absent` or `expect` query
  that writes shows as `deny`.
- `policy test` cases can name a verb instead of a script; see
  [Test a policy](policy.md#test-a-policy).

## Limits

- The guard sees the text of each statement, not what a called program or trigger does. IBM i
  authority remains the real boundary.
- Verbs hold SQL and CL only: no 5250 screen steps.
- The run log is a local record the user can edit, not an audit trail.

Back to the [root README](../README.md) or the [server README](../packages/server/README.md).
