# ibmi-agent-kit

One MCP server for IBM i. It gives an AI agent 5250 green screens, source members, and SQL
and CL, all through the signed-on user's own IBM i profile. Each user signs on as themselves,
so IBM i object authority stays the real boundary. An execution guard catches dangerous mistakes
in `run_script` and `verb_run` before they run; see [Safety](#safety).

## Packages

| Package | What |
|---|---|
| [`packages/core`](packages/core/README.md) | profile loader and the SQL transport type |
| [`packages/guard`](packages/guard/README.md) | execution guard: classifier, CL command table, policy |
| [`packages/screen`](packages/screen/README.md) | 5250 engine |
| [`packages/source`](packages/source/README.md) | source and SQL engine |
| [`packages/server`](packages/server/README.md) | the stdio MCP server, `list_servers`, `run_script`, `policy_check`, `verb_list`, `verb_run` |

## Install

From this repo, with Node 20 or newer. Nothing is published to npm.

```sh
git clone https://github.com/klintravis/ibmi-agent-kit
cd ibmi-agent-kit
npm ci && npm run check
claude mcp add ibmi-agent-kit -- node <abs path>/packages/server/dist/index.js
```

Use the absolute path to this checkout in place of `<abs path>`. Restart Claude Code or run
`/mcp`. The server speaks MCP on stdio and exits when the client closes it.

## Tools

Pass `server` (a name from `list_servers`) to pick which IBM i; omit it for the default.

| Tool | Package | What it does | Read-only / changes / runs code |
|---|---|---|---|
| `run_tests` | screen | Replays Markdown screen regression tests against a program | changes; runs code |
| `screen_do` | screen | Types into fields and presses keys on the 5250 screen | changes; runs code |
| `screen_snapshot` | screen | Returns the current screen | read-only |
| `session_close` | screen | Signs off and closes a 5250 session | changes |
| `session_open` | screen | Signs on and opens a 5250 session, optionally starting a program | changes; runs code |
| `list_servers` | server | Lists configured servers and open sessions | read-only |
| `policy_check` | server | Shows what the execution policy would decide for a script, or for every statement a verb would send, without running it | read-only |
| `run_script` | server | Runs SQL and CL after the execution policy decides every statement | changes; runs code |
| `verb_list` | server | Lists the verbs (named, parameterised procedures in YAML files) by layer, with tags, parameters and overrides | read-only |
| `verb_run` | server | Runs a verb, or every verb with a tag, after the execution policy decides every statement | changes; runs code |
| `compile_member` | source | Compiles a source member and parses the compile messages | changes; runs code |
| `list_libraries` | source | Lists libraries | read-only |
| `list_members` | source | Lists the members of a source file | read-only |
| `list_source_files` | source | Lists source files in a library | read-only |
| `manage_library_list` | source | Shows or changes the job's library list for the session | changes |
| `read_source_member` | source | Downloads a source member to a local editable copy | read-only |
| `run_sql` | source | Runs a SQL select | read-only |
| `search_source` | source | Searches source members for text | read-only |
| `upload_source_member` | source | Uploads a local file to a source member | changes |

The last column is each tool's MCP annotation (read-only or destructive) plus whether it runs a program or command. Each package README has the arguments and details.

## Profiles

A profile is one `.env` file naming one IBM i. Folders, first match wins:

1. `IBMI_KIT_CONFIG_DIR` (or the older `IBMI_MCP_CONFIG_DIR`), set on the MCP registration
2. `~/.ibmi-agent-kit`
3. `~/.ibm-i-servers`

`.env` is the server called `default`; `.env.<name>` is the server called `<name>`;
`.env.example` is never a server, and neither is `.env.default` (the default is `.env`), a
`.env.` with no name, a leftover ending `.bak`, `.orig` or `~`, or anything that is not a regular
file. A `server` argument must match a listed name exactly. One
file supplies the whole profile; files are never merged, and nothing from them is loaded into
the process environment. Copy `packages/source/.env.example` or `packages/screen/.env.example`
as a starting point. `list_servers` shows the folders searched and the open sessions.

Protected settings are read from the profile file only, never from the environment, so an MCP
registration's env cannot override them (`IBMI_KIT_CONFIG_DIR` does choose which profile folder
is read): `IBMI_HOST`, `IBMI_USER`, `IBMI_PASSWORD`, `IBMI_PARTITION`, `IBMI_KIT_POLICY`
(absolute path), `IBMI_KIT_VERBS` (absolute folders, separated by `;` on Windows and `:`
elsewhere), `IBMI_SQL_TRANSPORT`, `IBMI_RESTRICTED`, `IBMI_ALLOWED_CL`, `IBMI_BLOCKED_CL`,
`IBMI_BLOCKED_TABLES`, `IBMI_READ_ONLY`, `IBMI_5250_TLS_INSECURE`, `IBMI_MAPEPIRE_CA`,
`IBMI_MAPEPIRE_JAR`, and every `IBMI_*_PORT`
(`IBMI_SSH_PORT`, `IBMI_MAPEPIRE_PORT`, `IBMI_5250_PORT`, `IBMI_5250_VIEWER_PORT`). Other
`IBMI_*` settings may still come from the environment when the file omits them.

## SQL transports

`IBMI_SQL_TRANSPORT` picks how SQL and CL reach the IBM i. Default `ssh`.

| Transport | Needs on the IBM i | Notes |
|---|---|---|
| `ssh` | SSH access for the user, a Java runtime, and write access to their home folder | Uploads the bundled Mapepire jar into the user's home and runs it in the user's job over that SSH session. No port to open, but uploading a jar may need your security team's approval. |
| `daemon` | A Mapepire server run by an administrator, listening on `IBMI_MAPEPIRE_PORT` (default 8076) | No SSH and no upload. The server must already be installed and started; the kit does not install it. If its certificate is not signed by a public CA, set `IBMI_MAPEPIRE_CA` to a PEM file holding the CA. |

Some source tools (for example `search_source`) need more on the box; see
`packages/source/README.md`.

## PUB400

PUB400 is a free public IBM i for learning. For the kit:

- 5250 is on port 992 with TLS: `IBMI_5250_PORT=992`.
- SSH is on 2222, not 22: `IBMI_SSH_PORT=2222`.
- Never create objects in `QGPL`; use your own library.
- Non-commercial use only. Keep sessions few and close them when done.

## Moving from the old servers

The kit replaces `ibm-i-5250-mcp` and `ibm-i-source-mcp`.

- Remove the old registrations and add `ibmi-agent-kit` (above).
- `~/.ibm-i-5250-mcp`, `~/.ibm-i-source-mcp` and a `.env` in an install folder are no longer
  read. Move the files into `~/.ibmi-agent-kit` (`~/.ibm-i-servers` is still read).
- `IBMI_*` connection and safety values set in the MCP registration's `env` are ignored for
  the protected settings above. Put them in the profile file.
- For the other `IBMI_*` settings the profile file now wins over the environment: the old servers
  let a value in the registration's `env` override the file, the kit uses it only when the file
  omits the setting.

## Safety

`run_script` runs every SQL statement and CL command through the execution guard: each is
classified, matched against a policy file (roles, environments, partitions, rules) and allowed,
confirmed with the user, or denied before anything is sent. `verb_run` does the same for every
statement of a verb, its nested verbs and its cleanup, and for every verb of a tag suite, decided
as one script before the first is sent; a verb runs with the signed-on user's rules, so sharing
one grants nothing. `policy_check` makes the same decisions but only reports them. With no
policy file the built-in policy (observe mode, one `allow` rule) logs every decision and runs
everything except `danger` operations and unqualified changes (a write with no library), which it
still denies (see [Policy](#policy)).

The source tools are decided the same way before they act: `run_sql`, `read_source_member` and
`search_source` as reads of their table, source file or library; `upload_source_member` as a write
to the member's source file; `manage_library_list` changes as `liblist` on each library (`show` is
not decided); `compile_member` from its final command, `command` override included, plus the
member's statements, read at decision time, for an SQL member or `RUNSQLSTM`. A denied call sends
nothing to the IBM i, and the source engine's own checks still apply.
`compile_member`'s default target `*CURLIB` is decided as the job's current library; with none, the
compile is denied as unqualified, so pass `targetLibrary`.

The 5250 tools are decided too. Before `screen_do` or `run_tests` sends a key that carries field
data (any key but F3, F12, Clear and Attn), the text on the screen's command line at that moment,
typed or brought back with F9, is decided as a CL command; a denied one is not sent. F4 with a
command on the line is denied in every mode, observe included, like a `?` prompt: the prompter's
values are typed later on a screen with no command line, where the guard does not see them.
`session_open` reads the sign-on screen's System name (which then places the box in its partition),
then decides its `program` (or the profile's `IBMI_5250_PROGRAM`) as a `call` and its `library` (or
`IBMI_5250_CURLIB`) as `liblist` before typing them; a deny signs nothing on. `menu` is not
decided. The session's own sign-on, recovery and sign-off keys are never decided. A command line
runs in the 5250 job, which the guard cannot see into, so there `*CURLIB` is decided as
unqualified and a write through an alias or view in `QTEMP` is denied. A menu option (digits only)
typed on a `===>` line is not decided; any other text there that is not a command is denied. Each
decision reads the user's identity over SQL; when that lookup fails (a profile with no working SQL
connection, say), the profile's user decides with `default_role`, the run log says the lookup
failed, and it is tried again after a minute.
These decisions, and those of `run_script` and `verb_run`, go to a local run log. Read [packages/guard/README.md](packages/guard/README.md) for how it works and
[docs/policy.md](docs/policy.md) for the policy file, and [docs/verbs.md](docs/verbs.md) for verbs.

Limits, stated plainly: the guard sees only the text it is given, not what called programs or
triggers do, nor menu options, prompted fields or options typed on a list screen; IBM i authority
remains the real boundary. The source tools also use `IBMI_READ_ONLY`, `IBMI_BLOCKED_TABLES` and
`IBMI_BLOCKED_CL` (compile commands only). The 5250 tools also use `IBMI_RESTRICTED` (an allowlist, on by default), `IBMI_ALLOWED_CL` and
`IBMI_BLOCKED_CL` (the last applies only when restricted is off); they ignore `IBMI_READ_ONLY`.
Those three check text as it is typed into a command line and again, before the guard, on what the
line holds when the key is pressed, so a command brought back with F9 meets both.
The guard's catalog lookups have not yet been verified on a live IBM i.

## Policy

The guard's rules are one YAML file, set per profile with `IBMI_KIT_POLICY` (an absolute path). Field
reference, command tables and the test format are in [docs/policy.md](docs/policy.md); this is the
outline. This example, [examples/three-partitions.yaml](examples/three-partitions.yaml), uses invented
names and is tested by [examples/three-partitions.tests.yaml](examples/three-partitions.tests.yaml):

```yaml
version: 1
mode: { default: observe, prod: enforce }
partitions:
  - { name: dev,  systems: [DEVBOX],  rdbs: [DEVRDB] }
  - { name: qa,   systems: [QABOX],   rdbs: [QARDB, QAIASP1] }   # mirror of prod
  - { name: prod, systems: [PRODBOX], rdbs: [PRODRDB] }
unknown_partition: prod
command_files: [cm-product.yaml]          # e.g. CMPRM with class_by_param LEVEL → promote_qa
environments:                             # one list, first match wins
  - { name: scratch,    libraries: [QTEMP] }
  - { name: personal,   match: ["${USER}", "${USER}_*"], partitions: [dev] }
  - { name: blocked,    libraries: [PAYLIB] }
  - { name: test,       match: ["QT*"], partitions: [qa] }      # before system, so Q* does not swallow it
  - { name: system,     match: ["Q*", "SYS*"] }
  - { name: devlibs,    match: ["DV*", "CR*"], partitions: [dev] }  # incl. per-ticket libs
  - { name: integ,      match: ["IN*"], partitions: [dev] }
  - { name: stage_qa,   match: ["SQ*"], partitions: [dev] }
  - { name: stage_prod, match: ["SP*"], partitions: [dev] }
  - { name: live,       match: ["LV*"] }
roles:                                    # a user holds every role that matches
  - { name: qa,         groups: [GRPQA], authlists: [AUTLQA] }
  - { name: dev,        groups: [GRPDEV] }
  - { name: contractor, users: ["CTR*"] }
  - { name: analyst,    groups: [GRPANL] }
default_role: analyst
rules:                                    # first match wins; omitted key or `any` = anything; unmatched = deny
  - { classes: [danger], decision: deny }
  - { env: blocked, decision: deny }
  - { env: scratch, classes: [read, write, ddl], decision: allow }
  - { roles: [contractor], classes: [read], env: [personal, devlibs, integ], decision: allow }
  - { roles: [contractor], decision: deny }
  - { roles: [dev, qa], partition: dev, env: [personal, devlibs, integ], decision: allow }
  - { roles: [qa], partition: dev, classes: [promote_qa], decision: allow }
  - { roles: [qa], partition: qa, env: test, classes: [read, write, call], decision: allow }
  - { roles: [dev, qa], classes: [liblist], decision: allow }
  - { classes: [read], decision: allow }
```

- **Observe first.** `mode: observe` decides and logs and lets a statement run; `enforce` applies the
  decision. A map (`mode: { default: observe, prod: enforce }`) sets it per partition, so you switch
  boxes one at a time. A policy file without `mode` enforces. In every mode `danger` operations,
  unqualified changes (a write with no library) and a partition conflict are denied (except an
  unqualified command missing from the table in observe mode; see the limits below). With no policy
  file the built-in policy (observe, one `allow` rule) still denies `danger` operations and
  unqualified changes and logs everything.
- **Sections.** `partitions` map a 5250 System name and an SQL RDB name to a named box
  (`unknown_partition` catches the rest); `environments` group libraries by name or pattern, first
  match wins; `roles` and `default_role` say who is who; `rules` decide by role, partition,
  environment and class (`read`, `write`, `ddl`, `compile`, `call`, `liblist`, `promote`, your own),
  first match wins, no match is deny. A statement takes the most restrictive decision of its parts.
- **Command files.** The shipped CL command table is `packages/guard/src/commands.yaml`; an unlisted
  command is `danger` (except an unqualified command missing from the table in observe mode; see the
  limits below). `command_files` and `commands` add entries, and `class_by_param` classes a
  command by a parameter's value, so a change-management product's promotion to QA and to production
  are different classes (`CMPRM ... LEVEL(QA)` is `promote_qa` in the example's `cm-product.yaml`).
- **Roles.** A user holds every role whose group profile or supplemental group (`groups`),
  authorization list (`authlists`) or user-name pattern (`users`) matches, else `default_role`. The
  guard reads these over SQL as the signed-on user.
- **When the identity lookup fails** (a 5250-only profile with no working SQL connection, say), the
  guard decides as the profile's user with `default_role`, and the run log says so. User-name roles
  still match, and `danger` operations and unqualified changes stay denied. A failed lookup is
  retried after about 60 seconds and decides with `default_role` until then, so keep `default_role`
  your narrowest role.
- **`confirm`** asks the user once through MCP elicitation, naming each operation. Only an accepted
  form with `confirm: true` runs; a client without elicitation, a decline, a cancel and the 120 second
  timeout all deny.
- **Check before you trust it.** `policy_check` (a tool) reports the decisions for a script or verb
  without running it; it sends only the catalog lookups needed. With `as` (and optionally `policy`,
  a candidate file) it decides offline and sends nothing. `ibmi-agent-kit
  policy test <policy> <tests>` (see [docs/policy.md](docs/policy.md) for the command line) runs a test file offline (exit 0 pass, 1 fail, 2 bad file): run it in
  your company repo's CI. `ibmi-agent-kit policy replay <candidate> --since 14` replays the run log
  under a candidate and lists each statement whose decision changes: run it before you enforce.
- **Run log.** `run_script`, `verb_run`, guarded source tool and 5250 decisions are logged to
  `runs/YYYY-MM-DD.jsonl` in the first folder in `CONFIG_DIRS()` (`~/.ibmi-agent-kit/runs` unless
  `IBMI_KIT_CONFIG_DIR` is set); `policy_check` never logs. It is a local file
  the user can edit, not tamper-proof and not an audit trail.
- **Keep the agent out of the files.** Add client permission rules that deny the agent edits to the
  policy file, the profile files and any verb files; otherwise it can loosen its own rules.

Stated limits, beyond those under Safety:

- Library-list shadowing. In observe mode an unqualified command missing from the command table is
  logged as denied and runs, so after `ADDLIBLE MYLIB` an unqualified unknown `FROBCMD X` runs
  `MYLIB/FROBCMD`. Commands in `QSYS` cannot be shadowed this way, a qualified unknown command is
  denied, and so is an unknown command that names a program or command to run (`CMD`, `PGM`, ...).
- While observing, the command table's `danger` entries are the boundary: an IBM command missing from
  the table runs. Enforce mode denies it.

## Words

"Statements and commands" means SQL statements and CL commands. A "verb" is a named,
parameterised procedure (setup, steps, expectations, cleanup) that a person or a project writes
as a YAML file; see [docs/verbs.md](docs/verbs.md).

## Roadmap

`unified-kit` is done; `execution-guard` is built (the guard decides `run_script`,
`verb_run`, `policy_check`, the source tools and the 5250 tools, with `policy test` and `policy
replay`); a live check on PUB400 and the archive are open.
`project-verbs` is in progress (`verb_list`, `verb_run` and `policy_check` verb input are done;
an example verb and a live check are open). Next: `config-bootstrap`, a company pilot. See
`docs/idea.md`.

## Built on

`packages/screen` and `packages/source` are a hard fork of two Apache-2.0 servers by
SH4RKKK (Saman): https://github.com/SH4RKKK/ibm-i-5250-mcp and
https://github.com/SH4RKKK/ibm-i-source-mcp. Their license and notices are kept; changed
files carry a modification line. Apache-2.0, see `LICENSE` and `NOTICE`.
