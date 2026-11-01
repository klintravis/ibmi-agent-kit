# Tasks

## 1. Guard: detect and carry the warning

- [x] 1.1 `run.ts`: add `warnings: string[]` to `ScriptState`; `classify.ts` `classifyStatements` creates it empty. Verify `npm run check` builds.
- [x] 1.2 `cl.ts` `classifyClText`: just before `return ops`, for each explicit keyword in `parsed.params` not named by the entry (`paramSpecs` keys, `positional`, `class_by_param.param`, `nested_sql`; design D1) whose value holds a name-shaped element (not quoted, not numeric, not `*` without `/`; design D2), push the D3 wording to `run.state.warnings`. Verify with the selfcheck cases in 1.4.
- [x] 1.3 `types.ts` / `classify.ts`: add optional `ClassifiedStatement.warnings`; after each statement drain `state.warnings` into it (omit when empty) and append the same strings to `Classification.notes`. Verify with 1.4.
- [x] 1.4 `packages/guard/src/selfcheck.ts`: cases for every `statement-classification` scenario: undeclared `TOLIB` on an invented `XYZCPY` entry warns naming command and keyword, also as `TOLIB(*LIBL/OUT)`; shipped `DSPOBJD ... OBJTYPE(*FILE) OUTPUT(*OUTFILE) OUTFILE(B/OUT)` does not; `CRTBNDRPG ... DBGVIEW(*SOURCE) TEXT('Orders')` does not; operations and `decide()` result of `XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)` equal those of `XYZCPY FROMOBJ(APPLIB/ORD)`; a table declaring `TOLIB: library` silences it; `QSYS2.QCMDEXC('XYZCPY ...')` warns on the SQL statement; an unknown and a `danger` command do not warn; the warning appears in `Classification.notes`. Verify `npm run clean && npm run check` exits 0.

## 2. Guard offline: policy test results

- [ ] 2.1 `offline.ts`: `TestResult.statements[]` gains optional `warnings`, filled from the classified statement in both the script and the verb branch of `runPolicyTests`; `describeFailure` prints each as `    ! <warning>` under its statement. Verify with a selfcheck case (script and verb) that a passing case carries the warning, `ok` is unchanged, and `describeFailure` shows it.
- [ ] 2.2 `packages/guard/README.md` (Offline `policy test` bullet): say undeclared-parameter warnings go to stderr and do not change the exit code. Verify the text matches the CLI behaviour in 3.2.

## 3. Server: policy_check and policy test output

- [ ] 3.1 `guarded.ts` `policy_check`: `report()` adds `warnings` when the statement has any, for the live script (`p.statement`), live verb (`checkVerb` statement) and offline (`TestResult` statement) paths; the text adds one `    ! <warning>` line per warning before the operation lines. Annotation stays `readOnlyHint: true`. Verify with `packages/server/src/selfcheck.ts` cases: live script and offline `as` with an undeclared keyword show `warnings` and the text line, decision unchanged; declared-only scripts have no `warnings` key.
- [ ] 3.2 `policy-cli.ts` `test`: for every result print `warning: <case>: <warning>` on stderr; exit code logic untouched. Verify with a server selfcheck case: a passing suite with an undeclared keyword exits 0, stderr has the warning, stdout unchanged.
- [ ] 3.3 Run log: verify with a server selfcheck case that `run_script` on a stub transport records the warning in the first line's `notes` (no `runlog.ts` change expected).
- [ ] 3.4 `packages/server/README.md`: `policy_check` row mentions per-statement `warnings`; the `policy test` paragraph mentions the stderr warnings. Verify the wording matches 3.1 and 3.2.

## 4. Docs

- [ ] 4.1 `docs/policy.md` command tables `params` row and `templates/company-repo/README.md` `params` bullet: keep the limit sentence and add that `policy_check` and `policy test` warn when a command is given a parameter its entry does not name (and that a keyword listed only in `positional` is treated as considered). `docs/policy.md` Test a policy / `policy_check` section: one line on the warning. Verify the links resolve and `node scripts/check-names.mjs` passes (invented names only).

## 5. Integration

- [ ] 5.1 Run `node packages/server/dist/index.js policy test examples/three-partitions.yaml examples/three-partitions.tests.yaml`: exit code as before; list any warnings it prints (gaps in the shipped table) in the change's commit message for a follow-up todo, do not fix them here. Then `npm run clean && npm run check` exits 0.

## Workflow follow-up

- Fresh review, merge, then archive the change.
- Add a desk todo for shipped-table gaps the warning exposes (e.g. `CRTPGM BNDSRVPGM`, `BNDDIR`).
