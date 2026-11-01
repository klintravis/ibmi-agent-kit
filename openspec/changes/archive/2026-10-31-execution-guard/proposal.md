# Proposal

## Why

Developers, analysts and QA sign on with their own IBM i profiles, and agents write SQL and CL for
them. Their authority usually allows far more than any one task needs: a developer can clear a
file in an integration library as easily as in their own, and an agent that misreads a library
name does real damage. The engines guard only narrow cases today. The kit needs one configurable
guard that decides every operation from who is running it, which partition and library it
touches, and what it does — that a team can roll out in observe mode first, and that says plainly
it catches mistakes, not a determined user.

## What Changes

- New **execution policy** (`IBMI_KIT_POLICY`), shaped to fit many shops: partitions identified
  by system and RDB name (IASPs included); one ordered list of library environments with optional
  per-partition scope and `${USER}`; roles from group profiles, supplemental groups, authorization
  lists or user names, with users holding every role that matches; ordered rules (roles × partition
  × environment × class → allow | confirm | deny), unmatched → deny; reference checks and shadow
  warnings. `mode` is `observe`, `enforce`, or per partition. With no policy file a built-in policy
  applies in observe mode, so installing the guard changes nothing until a team opts in.
- **Change-management products as data:** `command_files` share a product's command table between
  companies; `class_by_param` classes a promote command by its level parameter
  (`LEVEL(QA)` → `promote_qa`), so rules govern each promotion level.
- **Policy testing:** offline decisions for a stated identity; `ibmi-agent-kit policy test` for a
  company's CI; `ibmi-agent-kit policy replay` to see what a draft would change before enforcing.
- New **statement classification**: a literal- and comment-aware tokenizer; per-object read/write
  classification; aliases and views resolved to their base tables; recursion into `QCMDEXC`,
  `RUNSQL SQL`, `FINAL TABLE`, data-change CTEs and routine/trigger bodies; user functions classed
  as calls; a closed CL command table naming each command's library parameters and, where needed,
  the partition a target library belongs to; `SBMJOB`, unknown commands and commands qualified to a
  non-IBM library are `danger`; `CONNECT` and three-part names to unmapped databases are `danger`;
  long schema names matched by system name; `*CURLIB` resolved to the job's current library; other
  unqualified changes refused.
- **Guarded tools:** `run_sql`, `read_source_member`, `search_source`, `upload_source_member`,
  `compile_member` (the final command string, and for SQL members or RUNSQLSTM the member's
  statements read at decision time), `manage_library_list`, `session_open` sign-on fields, and every
  key that sends a 5250 command line (including after F9 retrieve).
- New tools `run_script` (SQL statements and CL commands, all decided — and all confirmations
  asked — before the first is sent) and `policy_check` (decide without running).
- **Confirmation:** one MCP elicitation per call listing every operation needing it; without
  elicitation, deny.
- A local **run log** with secrets redacted.

### MCP tools added or changed

| Tool | Annotation | Change |
|---|---|---|
| `run_script` | destructive | new |
| `policy_check` | read-only | new |
| `run_sql`, `read_source_member`, `search_source` | read-only | decided as reads of their objects |
| `upload_source_member`, `compile_member`, `manage_library_list` | destructive | decided before acting |
| `session_open`, `screen_do` | destructive | sign-on program/menu/library and command lines decided |

## Out of scope

- Stopping deliberate workarounds: what called programs and triggers do inside, menu options and
  prompted fields on application screens, dynamic SQL built at runtime. Stated limits.
- Verbs (`project-verbs`); CI service profiles; tamper-proof logging; a JDBC transport.
- Any company's real libraries, partitions or vendor commands: examples are invented.

## Capabilities

### New Capabilities
- `execution-policy`: policy file, mode, partitions, environments, roles, rules, decisions.
- `statement-classification`: how SQL and CL text becomes classed operations on objects.
- `guarded-tools`: guarded entry points, `run_script`, `policy_check`, confirmation.
- `run-log`: what is recorded about each decision and where.
- `policy-testing`: offline decisions, policy test files, and replaying the run log.

### Modified Capabilities
- None (`server-profiles`, `sql-transport` and `unified-server` from `unified-kit` are unchanged).

## Impact

- New `packages/guard` (pure: policy, classifier, command table, run log).
- `packages/server`: decision context, `run_script`, `policy_check`, confirmation, guard hooks.
- `packages/screen`: async guard hook before AID keys that send a command line; sign-on field
  check; System-name read from the sign-on screen. `packages/source`: guard hook at each tool.
- Depends on `unified-kit` (server, profile loader, transport `execute`/`cl`).
