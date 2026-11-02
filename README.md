# ibmi-agent-kit

One MCP server for IBM i. It gives an AI agent 5250 green screens, source members, and SQL
and CL, all through the signed-on user's own IBM i profile. Each user signs on as themselves,
so IBM i object authority stays the real boundary. An execution guard catches dangerous mistakes
in `run_script` and `verb_run` before they run; see [Safety](#safety).

The split of work: users sign on as themselves; what a company knows about its system (procedures,
naming, standards) lives in Claude skills in the company's private repo, and the MCP holds none of
it; the MCP executes and the guard checks.

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

Then create a profile and test it. Run this yourself in a real terminal (PowerShell, Windows Terminal, macOS Terminal or a Linux shell), not through Claude:

```sh
node <abs path>/packages/server/dist/index.js setup [name]
```

It asks for the host, the user, where the password comes from and an optional policy file, writes the profile, then connects and prints `OK` or why it failed. See [`setup` command](packages/server/README.md#setup-command).

**Passwords are not kept in the profile.** At the "password source" prompt press Enter for the OS credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service) and type the password once, hidden. Or type a helper command (for example your company's secret manager's CLI) that prints the password; the helper is run for every sign-on, and it is refused when the profile file is inside a git work tree. The command you type is shown on screen and stored as typed, so it must hold no secret. To rotate a password, change it on the IBM i, then run `node <abs path>/packages/server/dist/index.js credential set <profile>` (a helper: change the secret where it reads it). There is no `credential get`, on purpose. Limits:

- A password the IBM i rejected is not sent again by the same server process, so a stale password costs one sign-on attempt, not a locked profile. The record is per process and per user and host: several clients, several machines or a `setup` run each send it once, and together can still reach the IBM i limit (`QMAXSIGN`).
- An `IBMI_PASSWORD` line in an existing profile still works, with a warning on standard error that names the file. Run `setup` to move it to the store.
- Anyone who can run commands as you can read your store entry or run your helper. This keeps passwords out of files, not out of reach of your own account.

Details, helper rules and a Windows Credential Manager example: [Passwords](packages/server/README.md#passwords).

**In a company config repo** (one the `ibmi-kit-config` skill made; layout in [templates/company-repo](templates/company-repo/README.md)), follow that repo's README, Get started: clone it, run `setup` inside the clone, set `IBMI_KIT_HOME` to this checkout, run `claude` there. `setup` then takes the host, partition and other settings from the repo's profile skeleton and the policy path from the clone, and asks only your user and where your password comes from (each person chooses; the repo never supplies one). Its `.mcp.json` registers the server, so `claude mcp add` is not needed. See [In a company config repo](packages/server/README.md#in-a-company-config-repo).

Try it: [docs/demo.md](docs/demo.md) is a quick-start demo you can run against your own IBM i (or guided: `/demo`).

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
the process environment. `setup [name]` writes or updates one for you in the first folder
([`setup` command](packages/server/README.md#setup-command)). To write one by hand, copy
`packages/source/.env.example` or `packages/screen/.env.example`. `list_servers` shows the folders
searched and the open sessions.

Protected settings are read from the profile file only, never from the environment, so an MCP
registration's env cannot override them (`IBMI_KIT_CONFIG_DIR` does choose which profile folder
is read): `IBMI_HOST`, `IBMI_USER`, `IBMI_PASSWORD`, `IBMI_PASSWORD_COMMAND`, `IBMI_PASSWORD_STORE`,
`IBMI_PARTITION`, `IBMI_KIT_POLICY` (absolute path), `IBMI_KIT_VERBS` (absolute folders, separated by `;` on Windows and `:`
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
member's statements, read at decision time, for an SQL member or `RUNSQLSTM`. A member whose read
is denied is never fetched; one whose read a rule asks to confirm is fetched only after a yes, so
that prompt shows none of its lines. A denied call sends nothing to the IBM i, and the source
engine's own checks still apply.
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
failed, and the next decision tries the lookup again.
These decisions, and those of `run_script` and `verb_run`, go to a local run log. Read [packages/guard/README.md](packages/guard/README.md) for how it works and
[docs/policy.md](docs/policy.md) for the policy file, and [docs/verbs.md](docs/verbs.md) for verbs.

Limits, stated plainly: the guard sees only the text it is given, not what called programs or
triggers do, nor menu options, prompted fields or options typed on a list screen; IBM i authority
remains the real boundary. The source tools also use `IBMI_READ_ONLY`, `IBMI_BLOCKED_TABLES` and
`IBMI_BLOCKED_CL` (compile commands only). The 5250 tools also use `IBMI_RESTRICTED` (an allowlist, on by default), `IBMI_ALLOWED_CL` and
`IBMI_BLOCKED_CL` (the last applies only when restricted is off); they ignore `IBMI_READ_ONLY`.
Those three check text as it is typed into a command line and again, before the guard, on what the
line holds when the key is pressed, so a command brought back with F9 meets both.

## Policy

The guard's rules are one YAML file, set per profile with `IBMI_KIT_POLICY` (an absolute path):
partitions, environments, roles and first-match rules over the classes `read`, `write`, `ddl`,
`compile`, `call`, `liblist`, `promote` and your own. Start in `mode: observe` (decide and log,
block nothing extra) and switch partitions to `enforce` one at a time; `policy_check`, `policy test`
and `policy replay` check a policy before you trust it. A policy lives in your company repo and the
agent must not be able to edit it. Field reference, command tables, roles, the run log and stated
limits are in [docs/policy.md](docs/policy.md); a complete example with tests is
[examples/three-partitions.yaml](examples/three-partitions.yaml).

## Words

"Statements and commands" means SQL statements and CL commands. A "verb" is a named,
parameterised procedure (setup, steps, expectations, cleanup) that a person or a project writes
as a YAML file; see [docs/verbs.md](docs/verbs.md).

## Built on

`packages/screen` and `packages/source` are a hard fork of two Apache-2.0 servers by
SH4RKKK (Saman): https://github.com/SH4RKKK/ibm-i-5250-mcp and
https://github.com/SH4RKKK/ibm-i-source-mcp. Their license and notices are kept; changed
files carry a modification line. Apache-2.0, see `LICENSE` and `NOTICE`.
