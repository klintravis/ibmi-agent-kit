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
one grants nothing. `policy_check` makes the same decisions but only reports them. Without a
policy file the guard only observes and logs, apart from statements it always denies.
`run_script` and `verb_run` decisions go to a local run log. Read [packages/guard/README.md](packages/guard/README.md) for how it works and
[docs/policy.md](docs/policy.md) for the policy file.

Limits, stated plainly: the guard sees only the text it is given, not what called programs or
triggers do; IBM i authority remains the real boundary. It is not yet wired into `run_sql`,
`compile_member`, the other source tools or the 5250 tools, which keep their own checks. The
source tools use `IBMI_READ_ONLY`, `IBMI_BLOCKED_TABLES` and `IBMI_BLOCKED_CL` (compile commands
only). The 5250 tools use `IBMI_RESTRICTED` (an allowlist, on by default), `IBMI_ALLOWED_CL` and
`IBMI_BLOCKED_CL` (the last applies only when restricted is off); they ignore `IBMI_READ_ONLY`.
The guard's catalog lookups have not yet been verified on a live IBM i.

## Words

"Statements and commands" means SQL statements and CL commands. A "verb" is a named,
parameterised procedure (setup, steps, expectations, cleanup) that a person or a project writes
as a YAML file; see the [server README](packages/server/README.md#verbs).

## Roadmap

`unified-kit` is done; `execution-guard` is in progress (the guard decides `run_script`,
`verb_run` and `policy_check`; wiring it into the other tools and a live check are open).
`project-verbs` is in progress (`verb_list`, `verb_run` and `policy_check` verb input are done;
an example verb and a live check are open). Next: `config-bootstrap`, a company pilot. See
`docs/idea.md`.

## Built on

`packages/screen` and `packages/source` are a hard fork of two Apache-2.0 servers by
SH4RKKK (Saman): https://github.com/SH4RKKK/ibm-i-5250-mcp and
https://github.com/SH4RKKK/ibm-i-source-mcp. Their license and notices are kept; changed
files carry a modification line. Apache-2.0, see `LICENSE` and `NOTICE`.
