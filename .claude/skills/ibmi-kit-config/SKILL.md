---
name: ibmi-kit-config
description: Bootstrap or maintain a company's ibmi-agent-kit configuration (policy.yaml, its tests, command file, profile skeletons, smoke verb, CI) from read-only discovery of their IBM i. Use when an admin says "set up the kit for our company", "bootstrap the policy", "update our ibmi-agent-kit config", "our libraries or groups changed", or asks to re-check the policy against the box. Not for end users of the kit.
---

# ibmi-kit-config

For an admin, in a session where the kit's MCP server is connected to the company's IBM i under
the admin's own profiles (one per partition, as `list_servers` shows them) and the working folder
is the company's private config repo. The procedures write files with the client's own file
tools; no kit tool writes configuration.

## Rules

1. **Say first:** "Discovery only reads, and only what your own profile may read. Steps that come
   back short are reported as partial, and I ask instead."
2. **Read-only discovery.** Send only the `SELECT` statements in
   [references/discovery.md](references/discovery.md), through `run_sql` (`json: true`, an
   explicit `maxRows`, never `file: true`). The only other kit tools used are `list_servers` and
   `policy_check` with `as`, which decides offline and sends nothing.
3. **No passwords.** Never ask for, accept, write or read a password, token or key. Never open a
   `.env*` file outside this repo. Profile skeletons carry a comment where the password goes.
4. **Branch only.** Before the first write, create a branch; never commit to the default branch,
   never push or merge. The admin reviews and merges.
5. **Observe mode.** Every generated `policy.yaml` has `mode: observe`. Moving a partition to
   `enforce` is the admin's later edit, after `policy replay`.
6. **Evidence, then a question.** Every inference is shown with the rows behind it and asked as
   one question with a recommended answer ([references/questions.md](references/questions.md)),
   one at a time. Nothing inferred is written without the admin's answer.
7. **Copy, never reference.** Templates are copied into the repo and filled, so the company owns
   the files.

## What it generates

Exactly these paths in the company repo (the layout in the kit's
`templates/company-repo/README.md`), and nothing else:

```
README.md
policy.yaml
policy.tests.yaml
commands.yaml
profiles/.env.<partition>
verbs/smoke.yaml
.github/workflows/policy.yml
.claude/settings.json
```

`commands.yaml` only when discovery or the admin names a change-management product.

## The kit's commands

`ibmi-agent-kit policy test <policy> <tests>` and `ibmi-agent-kit policy replay <candidate> --since <days>`
(on PATH after `npm link -w packages/server` in the kit checkout; otherwise
`node <kit>/packages/server/dist/index.js policy ...`). Both are offline: no IBM i, no MCP.

## Bootstrap

1. **Check the session.** `list_servers` names a profile per partition. The working folder must be
   a git repo. Check its top level in this order:
   - It has a `policy.yaml` from this kit (its `version:` and `rules:`): run Maintain.
   - It holds nothing but `.git`, `README*`, `LICENSE*` and `.gitignore`: this is a bootstrap.
     This session's own Claude Code files may be there as well: a `.mcp.json` that registers
     ibmi-agent-kit, and a `.claude` folder with only `skills/` and `settings.local.json` in it.
   - Anything else: refuse and stop. Name the files that don't belong and say why. That covers an
     existing `.claude/settings.json`, `packages/`, `scripts/`, a `package.json` or another
     project's sources. The bootstrap writes `.claude/settings.json`, the policy files and its other
     files, so it would overwrite another project's files or mix into them. Usually the session
     started in the wrong folder, for example the workspace root, which is where the VS Code panel
     starts. Tell the user to make an empty repo, `cd` into it in a terminal and start `claude`
     there.

   Take the kit checkout's path (for templates and the CLI) from the `Args:` line of
   `claude mcp get ibmi-agent-kit` (`<kit>/packages/server/dist/index.js`). Ask only if the
   server is not registered there.
2. **Branch.** `git switch -c kit-config/bootstrap-<YYYY-MM-DD>`.
3. **Say the rule 1 sentence**, then discover: every group in `discovery.md`, on each profile
   (`server` set to it). Keep the rows in the conversation, not in files. Note each partial or
   missing step with its error.
4. **Infer** from the rows, then ask (`questions.md`, in its order):
   - partitions: S1 RDB, S3 (or S4) system name and S5 IASP RDBs per profile;
   - ladder: L1 prefixes of 2–3 characters with at least 3 libraries, ordered by J2 library lists
     and by which partition holds them, with L2 text as evidence;
   - personal libraries: I1 `OWN_CURLIB` against `USERS` per group;
   - roles: groups (I1, I2) whose members hold `*CHANGE` or `*ALL` (A1) on the same environments;
   - promote commands: C3 commands of a C2 product library whose text says promote or move.
5. **Generate**, in this order, with the client's file tools:
   1. `policy.yaml`: copy the nearest template from `<kit>/templates/policies/`
      (`single-partition-ladder` one partition with a ladder; `two-partition` dev and prod;
      `three-lpar` three partitions; `per-developer-libs` no ladder) and fill it from the answers.
      Keep `mode: observe`, `scratch` first, and the built-in-danger rule comment. Put a comment
      with the evidence (query ids) on each section.
   2. `commands.yaml`: one entry per promote command (`class_by_param` on the level parameter,
      `library`, `positional`), listed in `command_files`.
   3. `policy.tests.yaml`: for every role × environment, one case with a read and a write so it
      holds one allow and one deny where the policy allows only reads, plus an unknown command
      (`CL: ZZZUNKNOWN LIB(<lib>)`, expected deny) where the write is allowed; a user no role
      matches; and the promote command at every level, allowed and denied. Users are invented
      (Q18).
   4. `profiles/.env.<partition>`, one per partition:

      ```ini
      # ibmi-agent-kit profile skeleton for partition <partition>. Copy it to
      # ~/.ibmi-agent-kit/.env.<partition> and fill in your own user.
      IBMI_HOST=<host>
      IBMI_USER=YOUR_USER
      IBMI_SQL_TRANSPORT=ssh
      IBMI_PARTITION=<partition>
      IBMI_KIT_POLICY=<absolute path to this repo>/policy.yaml
      # The password is not kept here: add it in your own copy only, never in this repo.
      ```
   5. `verbs/smoke.yaml`: one verb, `name: SMOKE`, `tags: [smoke]`, one read step (Q19), and a
      test case for it in `policy.tests.yaml` (`verb: org:SMOKE`, `expect: allow`).
   6. `.github/workflows/policy.yml`: the CI block of `templates/company-repo/README.md`, with
      `ref` pinned to the kit commit the admin uses.
   7. `README.md`: from `templates/company-repo/README.md`, with this company's partitions and
      roles, and `Last maintenance run:` set to today.
6. **Test.** `ibmi-agent-kit policy test policy.yaml policy.tests.yaml` must print `N cases passed`
   with no `warning:` line. On a failure, fix the policy or the case with the admin and run again.
7. **Check per role.** For each role, call `policy_check` with `script` (one read and one write in
   that role's environment), `as` (the role's test user, groups and partition) and `policy` (the
   absolute path to the new `policy.yaml`), and show the decisions beside the tests.
8. **Write `.claude/settings.json` last**, once tests and checks pass: the permission rules (allow
   and deny) from the same README. They block edits to the files above, so nothing may be fixed after it.
9. **Commit on the branch** and give the admin a summary: files written, inferences and the
   answers behind them, partial discovery steps, and the test count. Stop there.

## Maintain

1. **Branch** `kit-config/maintain-<YYYY-MM-DD>`, then say the rule 1 sentence.
2. **Re-discover** (`discovery.md`) and diff against `policy.yaml` and `commands.yaml`:
   - library prefixes (L1) no environment matches: check one library of each with `policy_check`
     (`as`, `policy`), which reports its environment as `unmatched`;
   - groups (I1, I2) and authorization lists (I4) no role names;
   - systems or RDBs (S1, S3, S5, S6) no partition lists;
   - change-management products (C1, C2) added or gone, and commands (C3) not in `commands.yaml`.
3. **Read the run log** since the README's `Last maintenance run:` date: the day files
   `<config dir>/runs/YYYY-MM-DD.jsonl` only (the kit's config dir: `IBMI_KIT_CONFIG_DIR`, default
   `~/.ibmi-agent-kit`), never another file in that folder. Count lines
   whose operations have `env: unmatched`, whose `roleSource` is not `matched` (the default role
   decided), and whose `decision` is `confirm`, grouped by library, user and command. Read the
   files directly: the generated settings allow `~/.ibmi-agent-kit/runs/**`. Only if the log
   lives elsewhere (`IBMI_KIT_CONFIG_DIR` set to another folder) or the session's settings still
   deny the folder, ask the admin to copy those day files to a folder outside the repo, or to
   run the counts and paste them.
4. **Propose** each edit as a question with its evidence (as in Bootstrap step 4), then write the
   accepted edits and their new test cases. The repo's `.claude/settings.json` denies those
   edits: the admin lifts the rules for this session or makes the edit.
5. **Test and replay.** `ibmi-agent-kit policy test policy.yaml policy.tests.yaml`, then
   `ibmi-agent-kit policy replay policy.yaml --since <days since the last run>`, and show the
   statements whose decision changes.
6. **Record** today in the README's `Last maintenance run:`, commit on the branch, and summarise
   the differences, the edits, the test count and the replay result for review.

## Worked example

`templates/dry-run/` in the kit: `discovery.json` holds the query results and answers for an
invented three-partition shop, and `policy.yaml`, `commands.yaml`, `policy.tests.yaml` and
`verbs/smoke.yaml` are what Bootstrap writes from them. The kit's checks run its tests.
