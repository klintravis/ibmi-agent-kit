# @ibmi-agent-kit/core

The profile loader and the SQL transport type shared by every package in the [ibmi-agent-kit](../../README.md). It has no MCP tools.

## What it does

- Finds the profile folders and lists the servers they name.
- Resolves a server name to the settings of its one profile file.
- Defines the `SqlTransport` interface the source engine implements (Mapepire over SSH or a daemon).

## Exports

| Export | What it does |
|---|---|
| `CONFIG_DIRS()` | The profile folders, first match wins: `IBMI_KIT_CONFIG_DIR` (or the older `IBMI_MCP_CONFIG_DIR`), `~/.ibmi-agent-kit`, `~/.ibm-i-servers`. Evaluated per call. |
| `listServers()` | Sorted server names: `.env` is `default`, `.env.<name>` is `<name>`. Never a server: `.env.example`, `.env.default`, a bare `.env.`, a leftover ending `.bak`, `.orig` or `~`, anything that is not a regular file. |
| `resolveProfileEnv(name?)` | The settings of the named server as a plain object. The name must match a listed name exactly (it never becomes part of a path); an unknown name throws and lists what is available. |
| `SqlTransport`, `Msg` | Types only: `query`, `execute`, `cl`, `close`. |

## Configuration it reads

Profile files in the folders above. One file supplies the whole profile; files are never merged and nothing is loaded into `process.env`.

Settings that pick the box, the credentials, the transport or a guard are read from the profile file only, never from the environment, so a registration's env cannot override them (`IBMI_KIT_CONFIG_DIR` does choose which profile folder is read): `IBMI_HOST`, `IBMI_USER`, `IBMI_PASSWORD`, `IBMI_PARTITION`, `IBMI_KIT_POLICY`, `IBMI_KIT_VERBS`, `IBMI_SQL_TRANSPORT`, `IBMI_RESTRICTED`, `IBMI_ALLOWED_CL`, `IBMI_BLOCKED_CL`, `IBMI_BLOCKED_TABLES`, `IBMI_READ_ONLY`, `IBMI_5250_TLS_INSECURE`, `IBMI_MAPEPIRE_CA`, `IBMI_MAPEPIRE_JAR` and every `IBMI_*_PORT`. Other `IBMI_*` settings fall back to the environment when the file omits them.

See [Profiles in the root README](../../README.md#profiles) for the user-facing description.

## Tests

`src/selfcheck.ts`, run by `npm run check` from the repo root (or `npm run check -w packages/core`). No IBM i is needed.

Node 20 or newer.
