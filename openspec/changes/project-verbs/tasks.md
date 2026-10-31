# Tasks

## 1. Verb format and loading (verbs spec; D1, D4)

- [x] 1.1 Add the verb zod schema and loader to `packages/guard`: three layer folders, `<cwd>/.ibmi-kit/verbs` auto-load, `IBMI_KIT_VERBS`, closest-layer resolution with overridden marks, same-layer duplicate refusal, unknown-key refusal, cycle checks and at most 5 verbs in one call chain, the top one counted; selfcheck rows with temp folders for every load-time scenario; verify `npm run check -w packages/guard` passes
- [x] 1.2 Implement parameter validation and substitution: types incl. boolean, `:p` → ordered bound markers, `${p}` only for `allowed` or validated numeric/date/boolean, quote doubling in CL literals, load-time refusal of a free-text string in `${}`; selfcheck: string `${env}` without `allowed` refused, value outside `allowed` refused, `x' or '1'='1` arrives as a bound value with the statement text unchanged

## 2. Running verbs (verbs spec; D2, D3)

- [x] 2.1 Implement the runner in `packages/server`: substitute and decide every statement incl. nested verbs, one gathered confirmation, then `requires_absent` → setup → steps → cleanup through the `run_script` executor; expectations (`equals`, `rows`, `empty`); cleanup only for succeeded setup ids; reset handling; selfcheck with a stub transport: denied step sends nothing, declined confirmation sends nothing, `requires_absent` hit runs neither setup nor cleanup, expectation mismatch reports expected and actual and stops steps, failed setup skips its cleanup, failed step runs eligible cleanups and reports each, reset fails the verb and sends nothing more (cleanup, nested verbs' and later suite verbs' included) and lists the cleanup not run; a suite's verbs are decided as one script (a QTEMP alias or CHGCURLIB in one verb cannot open the way for the next)
- [x] 2.2 Add `verb_list` (read-only) and `verb_run` (destructive, `verb` or `tag`), and `verb`/`args` input on `policy_check`, with structured content; selfcheck: analyst context refused a verb writing a denied library, `policy_check` with a verb runs nothing, `tag` suite continues after a failure with correct counts and skips naming missing parameters, no tool writes verb files; `policy test` cases with `verb`/`args`; selfcheck one verb case

## 3. Documentation and example

- [ ] 3.1 Add `examples/verbs/SMOKE-SAMPLE.yaml` for the user's own PUB400 library (setup creates a table and inserts a row with `requires_absent`, an expectation, cleanup drops the table) and a README "Verbs" section (layers and override, `:p` vs `${p}`, `requires_absent`, cleanup rule, `policy_check` with a verb, suites by tag); verify the example loads in the guard selfcheck, the README example is byte-identical, and `scripts/check-names.mjs` reports no hits

## 4. Integration

- [ ] 4.1 Root `npm run clean && npm run check` passes and the CI matrix is green after push
- [ ] 4.2 With a PUB400 profile, run `policy_check` with the sample verb and `verb_run tag: smoke` through Claude Code and record results in the PR; skip with a note if no account exists yet

## Workflow follow-up

- Archive with `/opsx:archive` after review, syncing specs into `openspec/specs/`.
