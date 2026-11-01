# Design

## Context

See proposal.md - Why. Today `classifyClText` (`packages/guard/src/cl.ts`) parses a command with
`parseCl` into keyword parameters (`parsed.params`) and positional values, maps positional values
onto the entry's `positional` order, then walks only `paramSpecs(entry)` (the entry's `params`
plus `writes`) to build operations. Any other keyword is parsed and then ignored. Operations feed
`decide()` and, for every guarded call, the run log; `Classification.notes` already carries
classifier notes (lookup failures) onto the call's first run log line (`guarded.ts` plan → log,
`verbs.ts` notes). `policy_check` builds its per-statement `report()` in `guarded.ts` from a
`ClassifiedStatement` (live script, live verb via `checkVerb`/`decidePlans`) or from
`TestResult.statements` (offline `as`, via `runPolicyTests`). `policy test` (`policy-cli.ts`)
prints only failed cases (`describeFailure`) on stdout and load warnings on stderr.

## Goals / Non-Goals

**Goals:**
- One check, in the guard, reused by every path that classifies CL (script lines, QCMDEXC and
  verb lists, nested CL), with output in `policy_check`, `policy test` and the run log.
- Decisions unchanged by construction.

**Non-Goals:**
- Knowing which IBM parameters name libraries. The table is the only source; the check reports
  what the table does not describe.
- Filling gaps in the shipped table (that changes decisions; a later change).

## Decisions

### D1. "Declared" means every keyword the entry names

Known keywords: `paramSpecs(entry)` keys (`params` and `writes`), `positional`,
`class_by_param.param` and `nested_sql`. Only `params` would be too noisy: the shipped entries
list `OBJTYPE`, `OUTPUT`, `DETAIL`, `MBROPT` and similar only in `positional`, so the shipped
`DSPOBJD ... OBJTYPE(*FILE) OUTPUT(*OUTFILE)` example would warn twice. Limit accepted: a keyword
listed only in `positional` that does name a library stays silent; listing it in `positional` is
the table author's statement that it was considered.

Only explicit keywords (`parsed.params`) are checked. Positional values always land on keywords
from `positional`, so they are known.

### D2. Only values that hold a name warn

A keyword warns only when its value has at least one element (the same walk `nameElements` does:
top-level `splitTop` items, first item of a parenthesised group) that is not quoted, not numeric
and not a `*` special value. `TEXT('Orders')`, `DBGVIEW(*SOURCE)`, `REPLACE(*YES)`,
`FMTOPT(*MAP *DROP)` stay silent; `TOLIB(PRODLIB)`, `X(LIB/OBJ)` and `BNDSRVPGM((LIB/SRV *DEFER))`
warn. Alternative (warn on every unknown keyword) rejected: every compile in a company CI would
warn on `TEXT` and `DBGVIEW`, and people stop reading warnings. Remaining noise: name-shaped
values that are not objects (`ACTGRP(QILE)`, `TGTRLS(V7R4M0)`); accepted for a warning (see
Open Questions).

### D3. Where the check runs

In `classifyClText`, just before `return ops`, after every early `fail`/`danger` return. A command
not in the table, classed `danger`, or refused for its qualifier, `CALL QCMDEXC` or an unmapped
RDB already denies with its own reason; a warning on top adds nothing. One warning per keyword per
command, keywords in the order written.

Wording (one string, used everywhere):
`<CMD> <KEYWORD>(): the command table does not declare this parameter, so a library or object it names is not decided`
It names the command and keyword only, never the value, so it cannot carry a password into the
run log. A nested command gets no prefix: the statement it belongs to already shows the text.

### D4. A sink on the script state, never on operations

`ScriptState` gains `warnings: string[]`; `classifyClText` pushes to `run.state.warnings`. Nested
runs share the state, so CL inside `QCMDEXC`, `RUNSQL` and verb lists is covered and attributed
to the outer statement. `classifyStatements` drains the sink after each statement into a new
optional `ClassifiedStatement.warnings` (omitted when empty) and appends the same strings to
`Classification.notes`.

Operations are not touched. `decide()` reads operations only, and `raw` tool operations are what
the run log records and `policy replay` re-decides, so leaving them alone makes "decision
unchanged" true by construction and keeps the run log line format and replay unchanged.
Alternative (a `warning` field on `Operation`) rejected for that reason.

### D5. Output surfaces

- `policy_check`: `report()` adds `warnings` when the statement has any. Live script: from
  `p.statement.warnings`. Live verb: `checkVerb` statements carry the `ClassifiedStatement`, same
  field. Offline (`as`): `TestResult.statements[]` gains optional `warnings`, filled in both the
  script and the verb branch of `runPolicyTests`. The text gets one `    ! <warning>` line per
  warning under the statement, before the operation lines. `LIMITS` is unchanged.
- `policy test`: for every result, each warning goes to stderr as `warning: <case>: <warning>`
  (stderr is already where load warnings go, so stdout stays the pass/fail report).
  `describeFailure` lists the warnings under the statement as `    ! <warning>`. The exit code
  logic is unchanged.
- Run log: via `Classification.notes` (D4), so every guarded call that classifies text
  (`run_script`, `run_sql`, `verb_run`, the 5250 command line) records it with no change to
  `runlog.ts`. The source tools build their operations without the classifier and get none. `verb_run` already prints its
  verb notes as `note:` lines; that is a side effect, not a new surface.
- `policy replay`: re-classifies but prints only changed decisions; warnings not shown (out of
  scope).

## Risks / Trade-offs

- [Noise from name-shaped non-object values, e.g. `ACTGRP(QILE)`] → stderr only, exit code
  unchanged; docs say how to read it. A silencing key can follow if adopters ask.
- [Silent miss for a library-naming keyword listed only in `positional`] → documented in
  `docs/policy.md` next to `params`.
- [The shipped table itself has gaps the warning will expose, e.g. `CRTPGM BNDSRVPGM`] → by
  design; record what the selfcheck and the examples surface as a desk todo, do not fix here.
- [Run log notes grow] → one short string per undeclared keyword, holding no parameter value.

## Migration Plan

None. Additive output fields; no config, format or exit-code change. Rollback is a revert.

## Open Questions

- Whether a table key to mark keywords that name nothing (silencing a warning) is wanted. It
  changes neither this design nor its specs; decide after adopters see the warnings.
