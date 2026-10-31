# @ibmi-agent-kit/guard

The execution guard's pure half: it classifies SQL statements and CL commands, loads the policy file and decides allow, confirm or deny. It reads policy, command and test files and appends the run log; the [server](../server/README.md) supplies the catalog lookups and runs the statements.

The guard catches mistakes, it is not a security boundary. It classifies only the text it is given. It does not see what called programs, triggers, application menu options or prompted fields do, and options typed on a list screen are not command lines. IBM i object authority stays the real boundary.

Status: the guard decides `run_script` and `policy_check` only. It is not yet wired into `run_sql`, `compile_member`, the source tools or the 5250 tools, which keep their own checks. The catalog queries it uses (`USER_INFO`, `AUTHORIZATION_LIST_USER_INFO`, `SYSSCHEMAS`, `SYSVIEWDEP`, `SYSTABLES`, `LIBRARY_LIST_INFO`) and the format of the supplemental group list are not yet verified on a live IBM i.

## How a statement is decided

1. **Split and classify.** A script is split into SQL statements and CL commands (`CL:` lines). `classify` turns each into operations: a class (`read`, `write`, `ddl`, `compile`, `call`, `liblist`, `promote`, `danger`, or a custom class), the object, and the library. It follows aliases and views to their base tables, resolves long schema names, and looks inside `QCMDEXC`, `RUNSQL` and similar. Anything it cannot read safely is `danger`.
2. **CL command table.** `src/commands.yaml` lists the CL commands the guard knows and how to classify them. A command not in the table is `danger` (in observe mode an unqualified unknown command is only logged, unless it names a command or program to run (`CMD`, `PGM`, `RQSDTA`, `TRGPGM`, `CLASS`), which is denied in every mode; see below). A policy can add or extend entries with `command_files` and `commands`, including `class_by_param` (for example one class per promotion level). Format: [docs/policy.md](../../docs/policy.md#command-tables).
3. **Identity.** The user, group profile, supplemental groups, authorization lists and partition. Roles come from the policy's `roles` entries.
4. **Decide.** `decide` finds each operation's environment from its library, then the first matching rule gives `allow`, `confirm` or `deny`. No match is `deny`. A statement takes its most restrictive operation.

## Observe and enforce

| Mode | Behaviour |
|---|---|
| `enforce` | Decisions apply. This is the default for a policy file. |
| `observe` | Decisions are logged and the statement runs as if allowed. `danger`, `unqualified` and partition-conflict operations are still denied, as is an unknown command that names a command or program to run (`CMD`, `PGM`, `RQSDTA`, `TRGPGM`, `CLASS`). The built-in policy (used when a profile sets no `IBMI_KIT_POLICY`) is observe with one `allow` rule. |

Mode can be set per partition. Known limit while observing: the command table's `danger` entries are the boundary, so an IBM command missing from the table runs. An unqualified unknown command is logged as a denied-but-not-enforced `unknown_command`, and after `ADDLIBLE` it can resolve to a command in the added library.

## Run log

Each `run_script` statement is decided, confirmed if the policy says so, and appended as one JSON line to `<profile folder>/runs/YYYY-MM-DD.jsonl` (UTC date; the first folder in `CONFIG_DIRS()`, so `~/.ibmi-agent-kit/runs` by default). A line holds the time, server, tool, identity, roles, mode, policy hash, redacted statement text, each operation's class and decision, the rule number, `decision` (what the policy says) and `effective` (what happened), whether it was confirmed, the outcome, and the catalog answers the decision used. Passwords in CL parameters and SQL clauses, and the profile's own password, are replaced by `***`. The log is a local record the user can edit, not an audit trail. A write failure warns once on stderr and does not stop the call.

## Offline: `policy test` and `policy replay`

The functions live here (`runPolicyTests`, `replayRunLog`); the command is part of the server binary and needs no IBM i and no MCP client.

```sh
node <repo>/packages/server/dist/index.js policy test <policy> <tests>
node <repo>/packages/server/dist/index.js policy replay <candidate-policy> [--since <days>]
```

`npm link -w packages/server` makes `ibmi-agent-kit` available on PATH, so `ibmi-agent-kit policy test …` works too.

- `policy test` decides each case in a YAML test file for a stated identity and lookup answers, and compares with `expect`. Exit 0 all passed, 1 a case failed, 2 usage or load error. See [examples/three-partitions.tests.yaml](../../examples/three-partitions.tests.yaml).
- `policy replay` re-decides the statements in the run log under a candidate policy and lists those whose decision changes. Run it before switching a partition from observe to enforce. It always exits 0 unless the arguments or files are bad.

## Exports

`classify`, `classifyCl`, `splitScript`, `parseCl`, `builtinCommands`, `mergeCommands`, `loadPolicy`, `parsePolicy`, `builtinPolicy`, `decide`, `rolesOf`, `environmentOf`, `detectPartition`, `RunLog`, `redact`, `runPolicyTests`, `replayRunLog`, `loadPolicyTests`, plus the types. Also `loadVerbs`, `resolveVerb` and related functions for project verbs (a library only: no MCP tool uses them yet).

## Configuration it reads

A policy file named by `IBMI_KIT_POLICY` in a profile (absolute path). Reference: [docs/policy.md](../../docs/policy.md).

## Tests

`src/selfcheck.ts`, run by `npm run check` from the repo root. Stubbed lookups, no IBM i.

Node 20 or newer. Back to the [root README](../../README.md).
