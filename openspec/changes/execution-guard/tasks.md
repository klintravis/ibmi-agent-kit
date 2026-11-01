# Tasks

## 1. Guard package and classifier (statement-classification spec; D1–D3)

- [x] 1.1 Create `packages/guard` (`@ibmi-agent-kit/guard`, declarations on, `check` = build + `node --test dist/selfcheck.js`, runtime deps `yaml` and `zod` only) and add it to the root check order after core; verify `npm run check -w packages/guard` runs
- [x] 1.2 Implement the lexer and splitter; table rows: semicolons in literals and delimited names, comments hiding keywords, comment stripping, `CL:` in any case, `+` continuation; verify all pass
- [x] 1.3 Implement SQL classification with a stub `lookups`: read/write/ddl/call/unqualified/danger, `FINAL|NEW|OLD TABLE`, data-change CTEs, routine and trigger bodies, non-built-in functions as `call`, `QCMDEXC` in `QSYS2` and `QSYS` as procedure and function, concatenated or variable arguments → danger, `EXECUTE IMMEDIATE`/`PREPARE`, `CONNECT`/`SET CONNECTION`/three-part names (danger unless the RDB is mapped), alias/view resolution adding base-table writes (incl. the QTEMP alias case), long schema → system name, `*CURLIB` resolution; one row per spec scenario plus each bypass from the reviews; verify all pass
- [x] 1.4 Ship `commands.yaml` per D3 and the CL classifier: keyword and positional parameters, `writes:`, `nested_sql:` for RUNSQL, per-parameter `partition:`, `RDB()` parameters, `library:` qualifier rule, `class_by_param` with custom classes, `*LIBL` unqualified, `*CURLIB` resolved, SBMJOB always danger, non-IBM qualifier → danger; rows incl. `DSPOBJD OUTFILE`, `CLRPFM FILE(B/X)`, positional `DLTF B/X`, `MYLIB/DSPOBJD`, `CMPRM … LEVEL(QA)` → `promote_qa`, `LEVEL(HOTFIX)` → danger; verify all pass

## 2. Policy (execution-policy spec; D4)

- [x] 2.1 Implement `loadPolicy` with a YAML 1.2 core schema and strict zod schemas (unknown key, missing file, unquoted `*` hint), `command_files` merge, `mode` as a value or per-partition map, the built-in observe-mode policy, and `examples/three-partitions.yaml` = the D4 example with its `cm-product.yaml`; selfcheck: typo key refused, missing path refused, `NO` stays a string, command-file error names that file, example and built-in load
- [x] 2.2 Implement reference checks and shadow warnings (undefined env/role/partition/class errors; shadowed environment, exact name and rule warnings); selfcheck rows: `env: intgr` refused, `Q*` before `QT*` warns, rule after a catch-all warns
- [x] 2.3 Implement environment matching (one ordered list, `partitions` filter, exact before pattern, `${USER}`, system-name only, `unmatched`, `unqualified`), partition detection from `systems`/`rdbs`/`IBMI_PARTITION`, and roles from groups, supplemental groups, authorization lists and users (every match held, else `default_role`); rows for every spec scenario
- [x] 2.4 Implement `decide`: first-match rules, any held role, omitted key or `any` = anything, default deny, most restrictive across operations, observe mode per partition (still denies `danger`, `unqualified`), partition disagreement deny; selfcheck the D4 example as a decision table over roles {dev, qa, dev+qa, contractor, analyst} × partitions {dev, qa, prod} × each environment × each class, incl. dev writes integ allowed, dev writes stage_qa denied, qa `promote_qa` allowed, contractor write denied, insert-into-own-lib-select-from-live allowed, QTEMP alias to live denied; observe mode: `FROBCMD X` runs logged `deny`/`enforced: false`/`unknown_command`, `MYLIB/FROBCMD X` denied, `FROBCMD X` + `PWRDWNSYS` denied, enforce mode `FROBCMD X` denied; `decide` returns each operation's reason; zero-operation statements (`COMMIT`, `VALUES 1`) and object-less CL (`WRKACTJOB`) each get an explicit, selfchecked decision; verify all pass
- [x] 2.5 Classifier: set reason `unknown_command` only on unqualified (or `*LIBL`/`*NLVLIBL`) commands missing from the table (`MYLIB/FROBCMD` keeps the qualifier reason); update the 1.4 `unknown command` row and add the qualified row; verify all pass

## 3. Policy testing (policy-testing spec; D9)

- [x] 3.1 Implement offline decisions (stated identity and lookups), the test-file schema, and `ibmi-agent-kit policy test`; ship `examples/three-partitions.tests.yaml` covering every role × environment allow and deny; selfcheck: the example suite passes, a mutated policy makes the named case fail with exit code 1
- [x] 3.2 Implement `ibmi-agent-kit policy replay <candidate> [--since N]` over run-log lines (which store identity and lookups); selfcheck with a fixture log: a stricter candidate lists exactly the statements whose decision changes

## 4. Run log (run-log spec; D8)

- [x] 4.1 Implement `redact` and `RunLog` (lines include identity and lookup answers for replay); selfcheck: password-bearing CL parameters and SQL clauses become `***`, profile password never present, observed deny line has `enforced: false`, unwritable folder warns once and does not throw; verify all pass

## 5. Server: decision context, tools and confirmation (guarded-tools spec; D5, D7)

- [x] 5.1 Implement the server's `lookups` over the transport and per-connection identity and partition resolution (D5); selfcheck with a stub transport: profile `dev` on a box whose RDB maps to prod decides as prod, System/RDB disagreement denies, empty `USER_INFO` → `default_role` logged, authorization-list role found; decide how non-text tools (read_source_member, upload_source_member, manage_library_list, session_open) are logged so replay re-decides them: decided in D8, they log their raw operations (own partition and env) and replay passes them to `decide` without `classify`; group 6 implements it
- [x] 5.2 Add `run_script` (destructive) and `policy_check` (read-only, optional `policy` and `as` for offline decisions) with structured content and `maxRows` bounds, honouring `IBMI_READ_ONLY` and `IBMI_BLOCKED_TABLES`; the tool layer decides every operation of the whole script before sending anything; selfcheck: one deny sends nothing, `FROBCMD X` then `PWRDWNSYS` sends nothing, an unmapped `CONNECT` then a `DELETE` sends nothing, declined confirmation sends nothing, failure stops later statements, read-only profile refuses an allowed update, `policy_check` sends only lookups, and with `policy`/`as` sends nothing
- [x] 5.3 Implement confirmation (D7): one elicitation per call, 120 s timeout, `confirm === true` required, operations shown before comment-stripped text, startup notice; selfcheck with an in-memory client: no capability → deny message, accept+true runs and logs `confirmed`, accept+false/decline/timeout deny

## 6. Engine hooks (guarded-tools spec; D6)

- [x] 6.1 Source: await the guard in `run_sql`, `read_source_member`, `search_source`, `upload_source_member`, `manage_library_list` and `compile_member` (final command string; member text fetched for SQL type or RUNSQLSTM), with modification notices; verify pre-existing source checks pass and new selfchecks prove the override-target case is decided against `LIVLIB` and a denied call never reaches the stub transport
- [x] 6.2 Screen: `pressKey` `guarded` option and the pre-AID command-line decision, `session_open` decision for `program`/`library`, sign-on System-field parse, with modification notices; verify pre-existing screen checks pass and new selfchecks with a fake screen prove F9-then-Enter on a denied command sends nothing, engine-internal sign-off is never decided, and the System field is read from a captured PUB400-style sign-on screen
- [x] 6.3 Identity fallback is not cached (owner ruling, 2026-10-31): only a successful identity lookup is kept per server; a failed one (the identity query, or the USER_INFO or authorization-list query throwing) decides that call with what was read (`default_role` when nothing matches), logged, and the next call tries again; USER_INFO with no row stays cached; verify selfchecks prove a lookup failing once is retried on the next call, which holds the group role, the same for a group or authorization-list lookup that throws once, and the successful lookup is then cached

## 7. Documentation

- [x] 7.1 README "Policy" section: observe-first rollout incl. per-partition mode, each policy section with the D4 example, command files and `class_by_param` for change-management products, roles from groups/authorization lists/users, `policy_check`, `policy test` in a company's CI, `policy replay` before enforcing, confirmation (clients without elicitation get deny), the run log (not tamper-proof), the stated limits (incl. library-list shadowing: in observe mode `ADDLIBLE MYLIB` then an unqualified unknown `FROBCMD X` runs `MYLIB/FROBCMD`; QSYS commands cannot be shadowed this way; and in observe mode the command table's danger entries are the boundary, so an IBM command missing from the table runs while observing), and client permission rules denying the agent edits to the policy, profile and verb files; verify the README example is byte-identical to `examples/three-partitions.yaml` and `scripts/check-names.mjs` reports no hits
- [x] 7.2 Update `docs/idea.md` roadmap; verify no claim there contradicts the specs

## 8. Integration

- [ ] 8.1 Root `npm run clean && npm run check` passes, and the CI matrix is green after push
- [ ] 8.2 With a PUB400 profile, run `policy_check` and `run_script` (create, insert, select, drop in the user's own library) through the kit in Claude Code in observe and enforce mode and record results in the PR; also check the guard's catalog lookups there: `USER_INFO.SUPPLEMENTAL_GROUP_LIST` format (ten-character slots or blank-separated), `AUTHORIZATION_LIST_USER_INFO`, `SYSVIEWDEP`/`SYSTABLES` columns, `LIBRARY_LIST_INFO`; skip with a note if no account exists yet

## Workflow follow-up

- Archive with `/opsx:archive` after review, syncing specs into `openspec/specs/`.
