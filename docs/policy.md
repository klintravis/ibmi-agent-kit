# Policy file reference

The execution policy is one YAML file that tells the [guard](../packages/guard/README.md) what each user may do in which library. It decides `run_script`, `verb_run` and `policy_check`, the source tools, the 5250 command line before each key that sends it, and `session_open`'s sign-on program and library (see [Safety in the root README](../README.md#safety)).
The guard catches mistakes. It classifies the text it is given, not what called programs or triggers do. IBM i object authority stays the real boundary.

## Turn it on

Set `IBMI_KIT_POLICY` in a profile file to the absolute path of the policy. Without it the built-in policy applies: observe mode, one `allow` rule, so nothing is blocked except `danger` operations and unqualified changes (a write with no library), and every statement is logged.

```ini
# %USERPROFILE%\.ibmi-agent-kit\.env.pub400   (Linux and macOS: ~/.ibmi-agent-kit/.env.pub400)
IBMI_KIT_POLICY=C:\Users\me\policies\pub400.yaml
# Linux and macOS: IBMI_KIT_POLICY=/home/me/policies/pub400.yaml
IBMI_PARTITION=play
```

A missing or invalid policy stops the server at startup and names the file. A relative path is refused. Keep the policy, the profile and any verb files out of the agent's reach with client permission rules, so the agent cannot edit them.

## Rollout

1. Start with `mode: observe`: everything is decided and logged, nothing extra is blocked.
2. Read the run log (the first folder in `CONFIG_DIRS()`, so `~/.ibmi-agent-kit/runs` unless `IBMI_KIT_CONFIG_DIR` (or the older `IBMI_MCP_CONFIG_DIR`) is set), write `policy test` cases, and run `policy replay <candidate>` (see [Test a policy](#test-a-policy)) to see which logged statements would change.
3. Switch partitions to `enforce` one at a time with the per-partition `mode` map.

## Fields

| Field | Required | What it is |
|---|---|---|
| `version` | yes | Must be `1`. |
| `mode` | no | `observe`, `enforce`, or a map `{ default: observe, prod: enforce }`. Default `enforce`. |
| `partitions` | no | Named boxes. Each lists `systems` (5250 System names), `rdbs` (SQL RDB names) or both. |
| `unknown_partition` | with `partitions` | The partition used for a box no entry names. |
| `command_files` | no | Files of CL command entries, relative to the policy's folder, merged in order. |
| `commands` | no | CL command entries written in the policy; applied after the files. |
| `environments` | no | Named groups of libraries, matched by exact name or pattern. First match wins. |
| `roles` | no | Named groups of users, by group profile, authorization list or user name. |
| `default_role` | no | The role held by a user no role matches. |
| `rules` | yes | The decisions. First match wins; no match is deny. |

Unknown keys are errors. Names (partition, environment, role) are letters, digits, `_` and `-`; `any` is reserved.

### Partitions

```yaml
partitions:
  - { name: play, systems: [PUB400], rdbs: [PUB400] }
  - { name: prod, systems: [PRODBOX], rdbs: [PRODRDB] }
unknown_partition: prod
```

The partition of a connection comes from the 5250 System name, the SQL RDB name (`CURRENT SERVER`) and the profile's `IBMI_PARTITION`. Every name that maps must map to the same partition, and a declared partition must exist; a disagreement is a conflict and denies everything, in every mode. If nothing maps, `unknown_partition` applies. A system or RDB may be listed by one partition only. The 5250 System name is the `System` field of the sign-on screen, read when `session_open` connects and kept for that server; until a session has read it, the RDB name and `IBMI_PARTITION` decide. A customised sign-on screen without that field gives no System name.

A three-part SQL name or a CL `RDB()` parameter that names a listed RDB is decided on that partition; one that names an unlisted RDB is `danger`.

### Environments

```yaml
environments:
  - { name: scratch,  libraries: [QTEMP] }
  - { name: personal, match: ["${USER}", "${USER}1"] }
  - { name: system,   match: ["Q*", "SYS*"] }
```

- `libraries`: exact system names. `match`: patterns using `*` and `${USER}` (the signed-on user). Give at least one.
- `partitions`: optional list; the entry applies only on those partitions.
- Order matters: the first entry that applies and names the library wins, exact names before patterns within it. Put narrow entries before wide ones (`QT*` before `Q*`).
- Two names are built in and reserved: `unmatched` (no entry names the library) and `unqualified` (an unqualified read or call).
- A library with a long SQL schema name is resolved to its system name by a catalog lookup; one that cannot be resolved is `unmatched`.

Loading warns on stderr when an entry or rule can never match because an earlier one covers it.

### Roles

```yaml
roles:
  - { name: dev,        groups: [GRPDEV] }
  - { name: qa,         groups: [GRPQA], authlists: [AUTLQA] }
  - { name: contractor, users: ["CTR*"] }
default_role: analyst
```

A user holds every role whose `groups` (group profile or supplemental group), `authlists` (authorization lists naming the user) or `users` (patterns) match. A user who matches none holds `default_role`, or no role if none is set. If the group lookup fails, user-name roles still match. If the identity lookup itself fails (a profile with no working SQL connection, as a 5250-only one may be), the profile's user is decided the same way with no groups, so usually as `default_role`; the run log notes the failure, and `danger` operations and unqualified changes stay denied in every mode. Only a successful lookup is kept: after any failed lookup the next call looks the user up again. With a SQL connection configured but not reachable, every guarded call, including each 5250 key that sends a command line, waits for the lookup to fail (up to the connect time limit). Keep `default_role` your narrowest role.

### Rules

```yaml
rules:
  - { classes: [danger], decision: deny }
  - { env: scratch, classes: [read, write, ddl], decision: allow }
  - { roles: [dev], partition: play, env: personal, decision: allow }
  - { roles: [dev], env: personal, classes: [ddl], decision: confirm }
  - { classes: [read], decision: allow }
```

| Key | Matches | Omitted |
|---|---|---|
| `roles` | the operation if the user holds any listed role | any role |
| `partition` | the operation's partition | any |
| `env` | the library's environment | any |
| `classes` | the operation's class | any |
| `decision` | `allow`, `confirm` or `deny` | required |

Each key takes one value, a list, or `any`. Rules are checked in order and the first that matches every key decides one operation. A statement takes the most restrictive decision of its operations. `confirm` asks the user (see below). A rule that names the class `unqualified` is an error: nothing can allow an unqualified change.

Always denied, in every mode: `danger` operations (a qualified command not in the table, or an unknown command that names a program or command to run (`CMD`, `PGM`, …); also a statement the guard cannot read safely, an RDB no partition lists), `unqualified` operations (a change with no library; name the library), and a partition conflict. In observe mode an unknown unqualified CL command is only logged (as denied, not enforced) and runs.

### Classes

| Class | What |
|---|---|
| `read` | Queries, display commands |
| `write` | INSERT, UPDATE, DELETE, MERGE and the like |
| `ddl` | CREATE, ALTER, DROP, object-creating and deleting commands |
| `compile` | Compile commands |
| `call` | CALL, program and command invocations |
| `liblist` | Library list changes |
| `promote` | Change-management promotion (usually via a command file) |
| `danger` | Never allowed |
| your own | Created with `class_by_param` or `class` in a command entry, such as `promote_qa` |

### Modes

`observe` decides and logs and lets the statement run as if allowed. `enforce` applies the decision. The map form sets a mode per partition:

```yaml
mode: { default: observe, prod: enforce }
```

While observing, the command table's `danger` entries are the boundary: an IBM command missing from the table runs. Qualified unknown commands (`MYLIB/FROBCMD`) are denied in every mode, and so is an unqualified unknown command that names a program or command to run (`CMD`, `PGM`, ...).

Library-list shadowing is a stated limit of observe mode: an unqualified unknown command is logged as denied (reason `unknown_command`, not enforced) and runs, so after `ADDLIBLE MYLIB` an unqualified `FROBCMD X` runs `MYLIB/FROBCMD`. `QSYS` commands cannot be shadowed this way. Enforce mode denies it.

### Command tables

The shipped table is `packages/guard/src/commands.yaml`. A command not in any table is `danger`. A policy adds entries in `commands:` or in files named by `command_files` (each file holds only a `commands:` section; rules, environments and roles cannot be included). A file that redefines a command the shipped table calls `danger` produces a warning.

The shipped table covers an ILE build and test in your own library: display and work-with commands (`read`), compiles and binds (`CRTBNDRPG`, `CRTRPGMOD`, `CRTSQLRPGI`, `CRTSQLCI`, `CRTCLMOD`, `CRTCBLMOD`, `CRTPGM`, `CRTSRVPGM`, `UPDPGM`, ... as `compile`), binding directories (`CRTBNDDIR`, `ADDBNDDIRE`, `RMVBNDDIRE`, `DLTBNDDIR` as `ddl`; the objects an entry names are only read), message files (`CRTMSGF`, `ADDMSGD`, `CHGMSGD`, `RMVMSGD`, `DLTMSGF` as `ddl`), program attribute changes (`CHGPGM`, `CHGSRVPGM` as `ddl`), files, members, data areas and data queues. A second object a command writes is a `write` of that object (`CPYF TOFILE`, `DSPOBJD OUTFILE`, `CRTSQLRPGI TOSRCFILE`). `ADDMSGD` and `CHGMSGD` with `DFTPGM(MYLIB/P)` are `danger` (the program runs later for whoever gets the message) and denied in every mode; with `DFTPGM(*NONE)` or none, the rules decide the `ddl`. `SBMJOB`, `QSH`, `RUNSQLSTM` and the other `danger` entries are denied in every mode.

```yaml
# cm-product.yaml: an invented change-management product
commands:
  CMPRM:
    class_by_param: { param: LEVEL, values: { QA: promote_qa, PROD: promote_prod }, default: danger }
    positional: [REQ, LEVEL]
```

| Entry key | Meaning |
|---|---|
| `class` or `class_by_param` | Exactly one. `class_by_param` picks a class from a parameter's value, with a `default`. |
| `library` | The product library the command must be qualified to; otherwise `danger`. |
| `positional` | Keyword order for values written without a keyword. A list given by position is written in parentheses, `CHGLIBL (A B C)`. More positional values than listed is `danger`. |
| `params` | Parameters that name an `object`, `library` or `rdb`, optionally `{ kind, class, partition }`. List every parameter that names a library or object: a parameter not listed is not interpreted, so a library it names is not decided. `policy_check` and `policy test` warn when a command is given a parameter this entry does not name (a keyword listed only in `positional` counts as named, so it stays silent even if it names a library). |
| `writes` | Object parameters that are written when given (for example `OUTFILE`). |
| `nested_sql` | The parameter holding an SQL statement, classified as SQL (`RUNSQL`). |
| `reason` | Shown with a `danger` class. |

## Confirmation

`confirm` rules make `run_script`, `verb_run`, the source tools (`run_sql`, `read_source_member`, `search_source`, `upload_source_member`, `manage_library_list`, `compile_member`) and the 5250 tools (`screen_do`, `run_tests`, `session_open`) ask once, via MCP elicitation, naming the server, partition, and each operation. Only an accepted form with `confirm: true` runs; a client without elicitation, a decline, a cancel and a 120 second timeout all deny. Nothing is sent before every confirmation is answered. One exception to asking once: after a confirmed read of an SQL member (type SQL or `RUNSQLSTM`), `compile_member` fetches the member and asks again for any of its statements that need it; the member is never fetched before that read is confirmed.

## Example

[examples/three-partitions.yaml](../examples/three-partitions.yaml) is a complete policy with three partitions, environments, four roles and a command file ([cm-product.yaml](../examples/cm-product.yaml)), and [examples/three-partitions.tests.yaml](../examples/three-partitions.tests.yaml) tests it. Every name in it is invented. Starting points for a new company repo (observe mode, with tests) are in [templates/policies](../templates/policies): `single-partition-ladder`, `two-partition`, `three-lpar` and `per-developer-libs`; the repo layout is in [templates/company-repo](../templates/company-repo/README.md). They are not published with the packages. An admin can have Claude Code generate that repo instead: the [ibmi-kit-config skill](../.claude/skills/ibmi-kit-config/SKILL.md) reads the IBM i (`run_sql` selects only), asks what it cannot discover, and writes an observe-mode policy with its tests on a branch; [templates/dry-run](../templates/dry-run/discovery.json) is a worked example for an invented shop, and the kit's checks run its tests.
## Test a policy

```sh
node <repo>/packages/server/dist/index.js policy test examples/three-partitions.yaml examples/three-partitions.tests.yaml
```

`npm link -w packages/server` puts `ibmi-agent-kit` on PATH, so `ibmi-agent-kit policy test …` works too. A test file is a YAML list of cases (this one is in `examples/three-partitions.tests.yaml`):

```yaml
- name: dev scratch
  as: { user: JDOE, groups: [GRPDEV], partition: dev }
  script: |
    DELETE FROM QTEMP.T;
    CL: CRTBNDRPG PGM(QTEMP/P)
  expect: [allow, deny]   # one decision per statement, or one for the script
```

`lookups` is optional: `schemas` maps a long schema name to its system name, and `bases` maps an alias or view to its base tables (`LIB.NAME`). `as` takes `user`, `groups`, `authlists`, `partition` and `curlib`. `expect` is the policy's decision, so an observe-mode deny is still tested as deny. Exit 0 all cases passed, 1 a case failed or a verb file is refused (2 when a case names the refused verb), 2 a bad file. In a team, run it in CI.

A case can test a verb instead of a script: give `verb` (a name, or `proj:NAME` / `org:NAME`) and optional `args` in place of `script`.

```yaml
- name: analyst cannot run the team order fix
  as: { user: ANL01, groups: [GRPANL], partition: prod }
  verb: FIX-ORDERS
  args: { order: 999001 }
  expect: deny
```

Every statement the verb would send is decided, in run order: each setup step's `requires_absent` query and statement, the steps (nested verbs in place), then the cleanup entries. A per-statement `expect` lists them in that order. Verbs are found in `.ibmi-kit/verbs/` in the folder you run the command from and in `verbs/` beside the policy file; personal verbs in `~/.ibmi-agent-kit/verbs` are never read, so CI decides the same everywhere. A `requires_absent` or `expect` query that does more than read decides as `deny`. A verb that is missing, refused at load or given bad arguments exits 2.

Before enforcing, replay the run log under the candidate:

```sh
node <repo>/packages/server/dist/index.js policy replay candidate.yaml --since 14
```

It prints each logged statement whose decision changes, and a count. It reads the run log in the first folder in `CONFIG_DIRS()` (`~/.ibmi-agent-kit/runs` unless `IBMI_KIT_CONFIG_DIR` (or the older `IBMI_MCP_CONFIG_DIR`) is set).

To check one script or verb without a connection from an agent, call `policy_check` with `script` or `verb` (and `args`), `as` and, optionally, `policy`.

Both warn, without changing a decision or the exit code, when a command is given a parameter its table entry does not name and the value looks like a library or object name: `policy test` prints `warning: <case>: <warning>` on stderr, `policy_check` returns a `warnings` list per statement. Add the parameter to the entry's `params` (or `positional`) to decide it.

## Run log

See [Run log in the guard README](../packages/guard/README.md#run-log). It is a local, editable record, not an audit trail. One line of `runs/YYYY-MM-DD.jsonl` (a single line in the file; wrapped here, with invented names and hash shortened):

```json
{"time":"2026-03-02T14:05:11.482Z","call":"6f1c2d9e-7a40-4b0e-9c1d-3a5b8e2f1d77","index":0,"server":"dev",
 "tool":"run_script","identity":{"user":"JDOE","groups":["GRPDEV"],"authlists":[],"partition":"dev"},
 "roles":["dev"],"roleSource":"matched","partition":"dev","mode":"observe","policy":"9b2e...41c7",
 "kind":"sql","text":"SELECT * FROM DVLIB.ORDHDR WHERE ORDNO = 1042",
 "operations":[{"class":"read","object":{"lib":"DVLIB","name":"ORDHDR"},"env":"devlibs","partition":"dev",
   "decision":"allow","enforced":false,"reason":"rule","rule":5,
   "message":"rule 5 allows read DVLIB.ORDHDR (environment devlibs, partition dev)"}],
 "lookups":{},"rule":5,"decision":"allow","effective":"allow","enforced":false,"outcome":"1 row(s)"}
```

`lookups` is on a call's first line only, and is empty here because no catalog lookup was needed. `policy_check` never writes the run log.

`decision` is what the policy says, `effective` what happened (in observe mode a rule's deny still runs, with `enforced: false`).

## Limits

- The guard sees the text it is given: not what a called program, trigger, menu option or prompted field does, and not options typed on a list screen.
- A decision is made against the job as it was when the script was planned; a job lost or reset in between refuses the send.
- Not verified on a live system: the supplemental-group list format, roles resolved from groups or authorization lists, alias and view resolution, and the `daemon` transport. Check them with `policy_check` as a normal user before you enforce.
- 5250: only the command line is decided, when a key that sends field data (not F3, F12, Clear or Attn) is pressed; F4 (prompt) with a command on the line is always denied, like `?`; `session_open`'s `menu` is not decided; the screen engine's restricted mode and `IBMI_BLOCKED_CL` also check what the line holds at the key, so a command brought back with F9 meets both them and the guard. A menu option (digits only) on a `===>` line is not decided; other text there that is not a command is denied. The guard cannot see the 5250 job, so on a command line `*CURLIB` is unqualified and a write through an alias or view in `QTEMP` is denied.
- `compile_member` with no `targetLibrary` compiles into `*CURLIB`, decided as the job's current library; with none, it is denied as unqualified.
