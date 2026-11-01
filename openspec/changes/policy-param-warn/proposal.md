# Proposal

## Why

The guard decides a CL command only by the parameters its command table entry declares in
`params`. A library named in any other parameter is not interpreted, so library-based rules never
see it: `XYZCPY FROMOBJ(A/X) TOLIB(PRODLIB)` is decided on `A` only when the table omits `TOLIB`.
The adoption dry run (2026-11-01, finding 3) hit this. The docs already state the limit (shipped with
the work-ready change), but a table author gets no signal when it happens. A warning in
`policy_check` and `policy test` shows the gap where the policy is being written and tested.

## What Changes

- The classifier notes, per statement, each CL command from the table that is given a parameter
  keyword the entry does not name, when that parameter's value holds a name (not only quoted text,
  numbers or `*` special values). The warning names the command and the keyword.
- `policy_check` (MCP tool, changed, still read-only) returns these warnings per statement, in its
  structured output and its text.
- `ibmi-agent-kit policy test` prints them on stderr for every case, passing or failing, and in a
  failing case's report. Its exit code does not change.
- The warning is added to the call's run log notes, so `run_script`, `verb_run` and the other
  guarded tools record it without a run-log format change.
- Docs: the line in `docs/policy.md` (command tables, `params`) and in
  `templates/company-repo/README.md` that states the limit points to the warning; the
  `policy_check` and `policy test` descriptions mention it.
- Decisions do not change: no operation, class, rule match, verdict or exit code differs.

Out of scope:
- Changing any decision, adding the missing parameters to the shipped command table, or turning
  the warning into a deny or a failing exit code.
- A table key to mark a keyword as naming nothing (to silence a warning); see design Open Questions.
- Showing the warning in `run_script` or `verb_run` replies, or in `policy replay` output.
- Commands not in the table (already `danger`), and keywords given by position (they map to the
  entry's `positional` list, which the entry already names).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `statement-classification`: a CL command given a parameter its table entry does not name yields
  a warning per statement; decisions are unchanged.
- `guarded-tools`: `policy_check` returns those warnings.
- `policy-testing`: `policy test` prints those warnings without changing its exit code.
- `run-log`: the warnings are recorded with the call's notes.

## Impact

- `packages/guard`: `cl.ts` (the check), `run.ts` (`ScriptState` warning sink), `classify.ts`
  and `types.ts` (`ClassifiedStatement.warnings`, `Classification.notes`), `offline.ts`
  (`TestResult` statements carry warnings; `describeFailure`), `selfcheck.ts`.
- `packages/server`: `guarded.ts` (`policy_check` report and text), `policy-cli.ts` (`policy
  test` stderr), `selfcheck.ts`.
- Docs: `docs/policy.md`, `templates/company-repo/README.md`, `packages/server/README.md`,
  `packages/guard/README.md`.
- MCP tools: `policy_check` changed (output gains `warnings`), annotation read-only unchanged. No
  tool added. No dependency added.
