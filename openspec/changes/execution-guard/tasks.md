# Tasks

## 1. Guard package and classifier (statement-classification spec, design D1–D3)

- [ ] 1.1 Create `packages/guard` (`@ibmi-agent-kit/guard`, `check` = build + `node --test dist/selfcheck.js`, no runtime dependency beyond `yaml` and `zod`); verify `npm run check -w packages/guard` runs and is wired into the root check order after core
- [ ] 1.2 Implement the lexer and statement splitter; table-driven selfcheck rows for semicolons in literals and delimited names, `--` and `/* */` comments hiding keywords, `CL:` lines; verify all pass
- [ ] 1.3 Implement SQL classification into per-object operations (read, write, ddl, call, unqualified, danger) incl. `FINAL/NEW/OLD TABLE`, data-change CTEs, routine and trigger bodies, `QCMDEXC` as procedure and function, `EXECUTE IMMEDIATE`/`PREPARE`; one selfcheck row per spec scenario plus each bypass named in the design reviews (quoted names, `LIB/OBJ`, `SET SCHEMA` then unqualified write); verify all pass
- [ ] 1.4 Ship `commands.yaml` (common IBM display, file, object, compile, library-list, job and system commands with library parameters and positional order) and the CL classifier with `SBMJOB CMD` / `RUNSQL SQL` recursion, `*LIBL`/`*CURLIB` as unqualified, unknown → danger; selfcheck rows incl. `DSPOBJD OUTFILE`, `CLRPFM FILE(B/X)`, positional `DLTF B/X`, nested `SBMJOB CMD(DLTLIB B)`; verify all pass

## 2. Policy (execution-policy spec, design D4)

- [ ] 2.1 Implement `loadPolicy` with strict zod schemas (unknown keys error with file and key), the built-in default policy, and the example policy from design D4 as `packages/guard/examples/three-partitions.yaml` with an invented-names header; selfcheck: typo key refused, example loads, default loads
- [ ] 2.2 Implement environment matching (ordered, exact before pattern, `$USER`, `unmatched`) and role resolution (priority order, supplemental groups, `default_role`); selfcheck rows for every spec scenario
- [ ] 2.3 Implement `decide`: first-match rules, default deny, most-restrictive across operations; selfcheck the D4 example as a decision table: dev vs qa vs analyst × dev/qa/prod partition × personal/integ/test/blocked/system × each class, incl. "insert into own lib select from prod" allowed and "qa promote on dev" allowed; verify all pass

## 3. Run log (run-log spec, design D7)

- [ ] 3.1 Implement `RunLog` (daily JSONL, policy hash, no profile secrets, one stderr warning on write failure); selfcheck with a temp folder: deny and confirmed lines have the right fields, password value never appears, unwritable folder warns once and does not throw

## 4. Guarded tools (guarded-tools spec, design D5–D6)

- [ ] 4.1 Add the `guard` hook to both engines' `register` and call it at `run_sql`, `upload_source_member`, `compile_member` (SQL members: classify the member text) and the screen command-line check; add modification notices; verify both engines' existing checks still pass and new selfchecks prove a denied call never reaches the stub backend or types anything
- [ ] 4.2 In the server, resolve partition and role per connection (D5) with caching, and build the decision context; selfcheck with a stub backend: profile named `dev` on a box mapped to `prod` decides as `prod`, lookup failure gives `default_role` and is logged
- [ ] 4.3 Add `run_script` (destructive) and `policy_check` (read-only), returning structured content; selfcheck: one denied statement sends nothing, a failure stops later statements, `policy_check` sends nothing and names the matching rule
- [ ] 4.4 Implement confirmation via `elicitInput` (D6); selfcheck with an in-memory client: no capability → deny with the stated message, accept runs exactly that statement and logs `confirmed`, decline and timeout → deny
- [ ] 4.5 Add the stated-limits text to deny messages and `policy_check` output; selfcheck asserts it is present

## 5. Documentation

- [ ] 5.1 README "Policy" section: the file's sections with the D4 example, how decisions are made, `policy_check` for testing a policy, confirmation and clients without elicitation, run log location and that it is not tamper-proof, and the stated limits; verify the example in the README is byte-identical to `examples/three-partitions.yaml`
- [ ] 5.2 Update `docs/idea.md` roadmap to mark this change; grep the tracked tree for the private-names list kept outside the repo; verify zero hits

## 6. Integration

- [ ] 6.1 Root `npm run check` passes for all packages from a clean `dist`
- [ ] 6.2 With a PUB400 profile, run `policy_check` and `run_script` (a create/insert/select/drop in the user's own library) through the kit in Claude Code, and record results in the PR; skip with a note if no account exists yet

## Workflow follow-up

- Archive with `/opsx:archive` after review, syncing specs into `openspec/specs/`.
