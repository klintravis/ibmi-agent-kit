# ibmi-agent-kit

One MCP server for IBM i. It gives an AI agent 5250 green screens, source members, and SQL
and CL, all through the signed-on user's own IBM i profile. Each user signs on as themselves,
so IBM i object authority stays the real boundary. A guard that catches dangerous mistakes
before they run is coming in the next change (`execution-guard`); it is not in this one.

Tools: `session_open`, `screen_do` and friends (5250), `read_source_member`, `compile_member` and
friends (source), `run_sql`, and one `list_servers`. Each package README lists its tools.

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
registration cannot lift a safety setting: `IBMI_HOST`, `IBMI_USER`, `IBMI_PASSWORD`,
`IBMI_SQL_TRANSPORT`, `IBMI_RESTRICTED`, `IBMI_ALLOWED_CL`, `IBMI_BLOCKED_CL`,
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

## Words

"Statements and commands" means SQL statements and CL commands. "Verbs" is reserved for
custom, named operations a project defines; those come later (`project-verbs`).

## Roadmap

`unified-kit` (this), then `execution-guard`, `project-verbs`, `config-bootstrap`, a company
pilot. See `docs/idea.md`.

## Built on

`packages/screen` and `packages/source` are a hard fork of two Apache-2.0 servers by
SH4RKKK (Saman): https://github.com/SH4RKKK/ibm-i-5250-mcp and
https://github.com/SH4RKKK/ibm-i-source-mcp. Their license and notices are kept; changed
files carry a modification line. Apache-2.0, see `LICENSE` and `NOTICE`.
