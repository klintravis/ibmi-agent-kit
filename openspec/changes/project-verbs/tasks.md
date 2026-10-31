# Tasks

## 1. Verb format and loading (verbs spec, design D1, D4)

- [ ] 1.1 Add the verb zod schema, loader for `IBMI_KIT_VERBS` and `<policy dir>/verbs/`, layer addressing, duplicate and unknown-key refusal, cycle and depth checks to `packages/guard`; selfcheck rows for every load-time scenario with temp folders; verify `npm run check -w packages/guard` passes
- [ ] 1.2 Implement parameter validation and substitution (`${p}` only for `allowed` or numeric/date types, CL quote doubling, `:p` → bound `?` markers in order); selfcheck: identifier parameter without `allowed` refused at load, value outside `allowed` refused, `x' or '1'='1` arrives as a bound value, CL string with a quote is escaped

## 2. Running verbs (design D2–D3)

- [ ] 2.1 Implement the runner in `packages/server`: decide all statements first, then setup → steps → cleanup through the `run_script` executor, expectations (`equals`, `rows`, `empty`), cleanup only for succeeded setup ids, confirm decline as failure; selfcheck with a stub backend: denied step sends nothing, expectation mismatch reports expected and actual and stops steps, setup collision skips its cleanup, failed step still runs eligible cleanups and reports each
- [ ] 2.2 Add `verb_list`, `verb_check` (read-only) and `verb_run`, `verb_test` (destructive) with structured content; selfcheck: an analyst-role context is refused a verb that writes a denied library, `verb_check` runs nothing, `verb_test` continues after a failure with correct passed/failed/skipped counts, and no tool writes verb files

## 3. Documentation and example

- [ ] 3.1 Add `examples/verbs/SMOKE-SAMPLE.yaml` targeting the user's own PUB400 library (create table in setup, insert, expect, drop in cleanup) and a README "Verbs" section (format, `${}` vs `:p`, layers, cleanup rule, `verb_check` for review); verify the example loads in the guard selfcheck and the README example is byte-identical to the file

## 4. Integration

- [ ] 4.1 Root `npm run check` passes from a clean `dist`
- [ ] 4.2 With a PUB400 profile, run `verb_check` and `verb_test smoke` on the sample through Claude Code and record the result in the PR; skip with a note if no account exists yet

## Workflow follow-up

- Archive with `/opsx:archive` after review, syncing specs into `openspec/specs/`.
