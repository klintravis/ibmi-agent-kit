# Tasks

## 1. Make the engines mountable (design D1, D2, D4, D7)

- [ ] 1.1 Split `packages/screen/src/index.ts` into `tools.ts` exporting `register(mcp, hooks)` (with `tightenProfile`, `skipTools`, and a returned `getSession` handle) and a thin `index.ts`; add the modification notice; verify `npm run check -w packages/screen` still passes 58/58
- [ ] 1.2 Same split for `packages/source/src/index.ts`, returning a `getBackend` handle; add the modification notice; verify `npm run check -w packages/source` still passes 46/46
- [ ] 1.3 Add optional bound `parameters` to source `runSql`, passed to `fetchRows` after `assertSelectOnly`; add a selfcheck case proving parameters reach the query call unchanged; verify the source check passes
- [ ] 1.4 Verify each engine still starts standalone: run `node packages/screen/dist/index.js` and `node packages/source/dist/index.js` with an MCP `tools/list` request on stdin and confirm the original tool names come back

## 2. Kit package and unified server (unified-server spec)

- [ ] 2.1 Create `packages/kit` (package.json with `bin`, tsconfig, `src/index.ts`, `src/selfcheck.ts`, `check` script) depending on both engines, `yaml`, `zod` and the MCP SDK; verify `npm install` at the root links the workspaces and `npm run check -w packages/kit` runs
- [ ] 2.2 Mount both engines in one `McpServer`, passing `skipTools: ["list_servers"]` to source and failing startup on any other duplicate name; selfcheck: tool list contains `session_open`, `run_sql`, exactly one `list_servers`, and an injected duplicate aborts startup with the tool named
- [ ] 2.3 Verify the kit serves over stdio by sending `initialize` + `tools/list` to `node packages/kit/dist/index.js` and checking the combined list

## 3. Pack loading and validation (knowledge-packs spec)

- [ ] 3.1 Define zod `.strict()` schemas for `pack.yaml`, schema, glossary and safety files, and the name rule `^[a-z][a-z0-9_]{0,30}$`; selfcheck cases: minimal pack loads, `My-Pack` refused, unknown key `discription` refused naming file and key
- [ ] 3.2 Implement `IBMI_KIT_PACKS` discovery (pack folder or folder of packs, platform delimiter), per-pack isolation of errors, duplicate-name refusal, and missing `pack.yaml` reporting; selfcheck cases for each spec scenario using temp folders
- [ ] 3.3 Implement the credential-key scan (D6) before validation; selfcheck: `password: hunter2` refused, error contains the key and not the value
- [ ] 3.4 Validate glossary references against the same pack's schema, queries and workflows; selfcheck: dangling query reference refused naming term and query
- [ ] 3.5 Add `pack_list`, `pack_describe` (with `filter`) and `pack_lookup` (terms, synonyms, fields, closest-names fallback), read-only annotated, returning structured content; selfcheck each against a fixture pack with no IBM i connection

## 4. Declared queries (pack-queries spec)

- [ ] 4.1 Parse `queries/*.yaml`: name, description, sql, typed parameters (required, default, allowed values, length), `maxRows`; count `?` markers outside string literals; run `assertSelectOnly` and pack blocked tables at load; selfcheck: update refused, marker mismatch refused naming the query
- [ ] 4.2 Register each query as `<pack>_<query>` with a zod input schema plus the engine `server` argument, read-only annotated, name collisions refused; selfcheck: tool appears with the right inputs, wrong type rejected before any backend call
- [ ] 4.3 Execute through the source `getBackend` handle with bound parameters, re-checking blocked tables against the selected profile at call time; return structured rows with column types, schema meaning/unit on matching columns, and truncation at `maxRows`; selfcheck with a stub backend: injection string arrives as a bound value with the statement text unchanged, truncation reported, meaning attached

## 5. Workflows (pack-workflows spec)

- [ ] 5.1 Load `workflows/*.md`: title from the first heading, name from the file, inputs from a fenced `inputs` YAML block; parse every `5250-*` block with the engine's `parseTest`; refuse undeclared `{{name}}` references and malformed blocks naming file and line; selfcheck each
- [ ] 5.2 Implement `workflow_run` (destructive annotation): validate inputs, substitute `{{name}}` only inside `type` values, run steps on the named open session via the engine's `applyActions` so the session guards apply, stop at the first failed expectation, return step outcomes and the final snapshot; selfcheck with a fake session: success, failure stops further actions, no-session error, blocked command stops the run
- [ ] 5.3 Add `all: true` suite mode: file-name order, defaults for inputs, skipped-with-reason when a required input has no default, failures do not stop the suite; selfcheck the counts

## 6. Safety merge (unified-server spec, design D5)

- [ ] 6.1 Implement `tightenProfile` as a pure function (union of blocked CL and tables, read-only per named profile) and pass it to both engines' `register`; selfcheck: a pack-blocked table is refused by `run_sql` and by a query tool, read-only on `prod` refuses `compile_member` on `prod` only, and a `restricted: false` safety key is a load error

## 7. Sample pack and documentation

- [ ] 7.1 Create `packs/pub400-sample/` with `pack.yaml`, a schema and glossary over real PUB400 catalog objects with clearly invented business meaning, two queries over `QSYS2` catalog views, and one short read-only workflow (sign-on menu → command entry → back); verify it loads with zero errors via `pack_list` in the kit selfcheck
- [ ] 7.2 Add a "Write a pack" section to the root README (folder layout, each file's keys with one example, `IBMI_KIT_PACKS`, registering the kit with Claude Code, PUB400 needs `IBMI_SSH_PORT=2222`), and a "Porting an existing SQL MCP" subsection mapping one query to a pack entry; verify every key shown appears in the zod schemas
- [ ] 7.3 Update `docs/idea.md` phases to mark phases 2 and 3 as this change; verify the doc has no claims contradicting the specs

## 8. Integration

- [ ] 8.1 Run `npm run check` at the root and confirm all three packages pass
- [ ] 8.2 With a PUB400 account in `~/.ibm-i-servers/.env.pub400`, register the kit with Claude Code, call `pack_list`, one sample query, and `workflow_run` on the sample workflow, and record the outcome in the PR description (skip with a note if the account does not exist yet)

## Workflow follow-up

- Archive the change after review with `/opsx:archive`, which creates the main specs under `openspec/specs/`.
