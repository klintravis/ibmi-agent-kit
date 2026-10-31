# Proposal

## Why

Developers, analysts and QA sign on with their own IBM i profiles, and agents write SQL and CL for
them. Their authority usually allows far more than any one task needs: a developer can clear a
file in an integration library as easily as in their own, and an agent that misreads a library
name does real damage. The engines today guard only narrow cases (select-only `run_sql`, a
command-line allowlist, destructive compile verbs). The kit needs one configurable guard that
decides every statement from who is running it, which partition and library it touches, and what
it does — and that says plainly that it catches mistakes, not a determined user.

## What Changes

- New **execution policy**: a YAML file (`IBMI_KIT_POLICY`) maps the box to a **partition**,
  libraries to **environments** (ordered patterns per partition), the signed-on user to a **role**
  (from their IBM i group profiles), and decides each operation by an ordered list of **rules**
  (role × partition × environment × class → allow | confirm | deny). Anything unmatched is denied.
  A built-in default policy applies when none is configured.
- New **statement classification** for SQL and CL: a tokenizer aware of string literals and
  comments; per-object read/write classification; recursion into `QCMDEXC`, `SBMJOB CMD`,
  `RUNSQL SQL`, `FINAL TABLE`, data-change CTEs and routine/trigger bodies; a closed CL command
  table recording which parameters name a library; unknown commands are denied; writes must
  name their library.
- **Guarded tools**: the policy runs before `run_sql`, `upload_source_member`, `compile_member`
  (including SQL members run by `RUNSQLSTM`), and CL typed on a 5250 command line by `screen_do`.
- New tools `run_script` (run a script of SQL statements and CL commands, every statement checked
  before the first is sent) and `policy_check` (classify and decide without running).
- `confirm` decisions ask the user through MCP elicitation; a client without elicitation gets deny.
- A local **run log** of every decision and outcome.

### MCP tools added or changed

| Tool | Annotation | Change |
|---|---|---|
| `run_script` | destructive | new |
| `policy_check` | read-only | new |
| `run_sql` | read-only | also subject to the policy's read rules |
| `upload_source_member` | destructive | decided as a write to the member's library |
| `compile_member` | destructive | decided as a compile into the target library; SQL members also by their statements |
| `screen_do` | destructive | CL typed on a command line also decided by the policy |

## Out of scope

- Stopping deliberate workarounds: programs that write once CALLed, triggers fired by allowed
  writes, menu options and prompted fields on 5250 screens, dynamic SQL built at runtime.
  These are stated limits, not features.
- Custom verbs (change `project-verbs`); CI and service profiles; tamper-proof logging.
- Any company's real libraries, partitions or vendor commands: the repo ships invented examples.

## Capabilities

### New Capabilities
- `execution-policy`: the policy file, partitions, environments, roles, rules and decisions.
- `statement-classification`: how SQL and CL text becomes classed operations on qualified objects.
- `guarded-tools`: which tools are guarded, `run_script`, `policy_check`, and confirmation.
- `run-log`: what is recorded about each decision and where.

### Modified Capabilities
- None. (`unified-server` and `server-profiles` from change `unified-kit` are unchanged.)

## Impact

- New `packages/guard` (policy, classifier, command table, run log), used by `packages/server`.
- `packages/screen` and `packages/source`: a guard hook at each tool entry point listed above;
  the engines' existing checks remain as a second layer.
- Depends on change `unified-kit` (server package, profile loader).
