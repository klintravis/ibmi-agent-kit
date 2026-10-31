# Tasks

## 1. Templates (config-bootstrap spec)

- [x] 1.1 Write `templates/policies/{single-partition-ladder,two-partition,three-lpar,per-developer-libs}.yaml` (observe mode, commented, invented names) and a matching `.tests.yaml` for each with one allow and one deny per role × environment; verify `ibmi-agent-kit policy test` passes all four and `scripts/check-names.mjs` reports no hits
- [x] 1.2 Add a guard selfcheck that loads every template and runs its tests, so CI fails if a template drifts from the policy format; verify it passes
- [x] 1.3 Write `templates/company-repo/README.md` (layout of a company config repo: profiles, `policy.yaml`, command files, `policy.tests.yaml`, `verbs/`, CI running `policy test`, client permission rules); verify every path it names matches the skill's generation step

## 2. The skill (config-bootstrap spec; D1–D5)

- [ ] 2.1 Write `.claude/skills/ibmi-kit-config/SKILL.md` with frontmatter (`name`, trigger-focused `description`) and the bootstrap and maintain procedures, the read-only and no-password rules, observe-mode generation, branch-only output; verify the description names its triggers and the body references only tools the kit provides
- [ ] 2.2 Write `references/discovery.md` (D2 queries, grouped, each with its minimum release and what it feeds) and `references/questions.md` (one question per unknown, with recommended defaults); verify every query is a `SELECT`/`VALUES` and every `policy.yaml` key the questions fill exists in the policy schema
- [ ] 2.3 Dry-run the bootstrap procedure against fixture discovery results (a JSON file of query results for an invented three-partition shop) and verify the generated policy passes its generated tests

## 3. Packaging

- [ ] 3.1 Ensure published packages exclude `.claude/` and `templates/` (`files` allow-lists in each package); verify `npm pack --dry-run -w packages/server` lists neither

## 4. Integration

- [ ] 4.1 Root `npm run clean && npm run check` passes and CI is green after push
- [ ] 4.2 With a PUB400 profile, run the skill's bootstrap in a scratch company repo and record the generated files and test results in the PR; skip with a note if no account exists yet

## Workflow follow-up

- Archive with `/opsx:archive` after review, syncing specs into `openspec/specs/`.
