# Tasks

## 1. Guard package and classifier (statement-classification spec; D1–D3)

- [ ] 1.1 Create `packages/guard` (`@ibmi-agent-kit/guard`, declarations on, `check` = build + `node --test dist/selfcheck.js`, runtime deps `yaml` and `zod` only) and add it to the root check order after core; verify `npm run check -w packages/guard` runs
- [ ] 1.2 Implement the lexer and splitter; table rows: semicolons in literals and delimited names, comments hiding keywords, comment stripping, `CL:` in any case, `+` continuation; verify all pass
- [ ] 1.3 Implement SQL classification with a stub `lookups`: read/write/ddl/call/unqualified/danger, `FINAL|NEW|OLD TABLE`, data-change CTEs, routine and trigger bodies, non-built-in functions as `call`, `QCMDEXC` in `QSYS2` and `QSYS` as procedure and function, concatenated or variable arguments → danger, `EXECUTE IMMEDIATE`/`PREPARE`, alias/view resolution adding base-table writes (incl. the QTEMP alias case), `*CURLIB` resolution; one row per spec scenario plus each bypass from the reviews; verify all pass
- [ ] 1.4 Ship `commands.yaml` per D3 and the CL classifier: keyword and positional parameters, `writes:`, `nested_sql:` for RUNSQL, per-parameter `partition:`, `*LIBL` unqualified, `*CURLIB` resolved, SBMJOB always danger, non-IBM qualifier → danger; rows incl. `DSPOBJD OUTFILE`, `CLRPFM FILE(B/X)`, positional `DLTF B/X`, `MYLIB/DSPOBJD`, `PRMOBJ … TOLIB(QTORD)` against partition qa; verify all pass

## 2. Policy (execution-policy spec; D4)

- [ ] 2.1 Implement `loadPolicy` with strict zod schemas (unknown key and missing file errors name file and key), `mode`, the built-in observe-mode policy, and `examples/three-partitions.yaml` = the D4 example; selfcheck: typo key refused, missing path refused, example and built-in load
- [ ] 2.2 Implement environment matching (ordered, exact before pattern, `$USER`, `unmatched`, `unqualified`) and role resolution (priority order, supplemental groups, no row or failure → `default_role` with reason); rows for every spec scenario incl. `QTORD` → test and `QSYS2` → system on qa
- [ ] 2.3 Implement `decide`: first-match rules, omitted key = any, default deny, most restrictive across operations, observe mode (still denies `danger`, `unqualified`), partition cross-check deny; selfcheck the D4 example as a decision table over roles {dev, qa, analyst} × partitions {dev, qa, prod} × each environment × each class, including: dev writes integ allowed, dev writes stage_qa denied, qa promote into qa allowed, analyst write anywhere denied, insert-into-own-lib-select-from-live allowed, QTEMP alias to live denied; verify all pass

## 3. Run log (run-log spec; D8)

- [ ] 3.1 Implement `redact` and `RunLog`; selfcheck: password-bearing CL parameters and SQL clauses become `***`, profile password never present, observed deny line has `enforced: false`, unwritable folder warns once and does not throw; verify all pass

## 4. Server: decision context, tools and confirmation (guarded-tools spec; D5, D7)

- [ ] 4.1 Implement the server's `lookups` over the transport and the per-connection partition and role resolution with `IBMI_PARTITION` cross-check (D5); selfcheck with a stub transport: profile `dev` on a box mapped to prod decides as prod, declared/detected mismatch denies, empty `USER_INFO` → `default_role` logged
- [ ] 4.2 Add `run_script` (destructive) and `policy_check` (read-only) with structured content and `maxRows` bounds, honouring `IBMI_READ_ONLY` and `IBMI_BLOCKED_TABLES`; selfcheck: one deny sends nothing, declined confirmation sends nothing, failure stops later statements, read-only profile refuses an allowed update, `policy_check` sends only lookups
- [ ] 4.3 Implement confirmation (D7): one elicitation per call, 120 s timeout, `confirm === true` required, operations shown before comment-stripped text, startup notice, optional browser fallback on the viewer server; selfcheck with an in-memory client: no capability → deny message, accept+true runs and logs `confirmed`, accept+false/decline/timeout deny, fallback page POST confirms only with its token

## 5. Engine hooks (guarded-tools spec; D6)

- [ ] 5.1 Source: await the guard in `run_sql`, `read_source_member`, `search_source`, `upload_source_member`, `manage_library_list` and `compile_member` (final command string; member text fetched for SQL type or RUNSQLSTM), with modification notices; verify pre-existing source checks pass and new selfchecks prove the override-target case is decided against `LIVLIB` and a denied call never reaches the stub transport
- [ ] 5.2 Screen: `pressKey` `guarded` option and the pre-AID command-line decision, `session_open` decision for `program`/`library`, sign-on System-field parse, with modification notices; verify pre-existing screen checks pass and new selfchecks with a fake screen prove F9-then-Enter on a denied command sends nothing, engine-internal sign-off is never decided, and the System field is read from a captured PUB400-style sign-on screen

## 6. Documentation

- [ ] 6.1 README "Policy" section: mode and the observe-first rollout, each policy section with the D4 example, `policy_check`, confirmation (clients without elicitation, the browser fallback and its weakness), the run log (not tamper-proof), the stated limits, and recommended client permission rules denying the agent edits to the policy file, profile files and verb folders; verify the README example is byte-identical to `examples/three-partitions.yaml` and `scripts/check-names.mjs` reports no hits
- [ ] 6.2 Update `docs/idea.md` roadmap; verify no claim there contradicts the specs

## 7. Integration

- [ ] 7.1 Root `npm run clean && npm run check` passes, and the CI matrix is green after push
- [ ] 7.2 With a PUB400 profile, run `policy_check` and `run_script` (create, insert, select, drop in the user's own library) through the kit in Claude Code in observe and enforce mode and record results in the PR; skip with a note if no account exists yet

## Workflow follow-up

- Archive with `/opsx:archive` after review, syncing specs into `openspec/specs/`.
