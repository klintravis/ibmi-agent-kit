# @ibmi-agent-kit/server

The kit's stdio MCP server: it mounts the [screen](../screen/README.md) and [source](../source/README.md) engines on one `McpServer`, adds the guarded tools, and owns logging and shutdown. The command is `ibmi-agent-kit`.

## Run it

```sh
npm ci && npm run check
claude mcp add ibmi-agent-kit -- node <abs path>/packages/server/dist/index.js
```

The server speaks MCP on stdio and exits when the client closes it. It needs Node 20 or newer. Nothing is published to npm.

## Tools it owns

The other tools come from the engines; see the Tools table in the [root README](../../README.md#tools).

| Tool | What it does | Annotation |
|---|---|---|
| `list_servers` | Lists the configured servers (the `.env.<name>` files), the open 5250 sessions on each, and the profile folders searched. | read-only |
| `run_script` | Runs SQL statements (`;` separated) and CL commands (lines starting `CL:`) in order. Every statement is classified and decided, and every confirmation asked, before the first is sent: one denied statement or a declined confirmation sends nothing. Stops at the first failure. Returns per statement the decision, outcome, rows affected, rows (up to `maxRows`, default 100, at most 1000) and messages. | changes data; runs code |
| `policy_check` | Decides a `script`, or every statement a `verb` (with `args`) would send, without running it: per statement the operations with library, partition, environment and class, the matching rule and the decision. Sends only the catalog lookups needed. With `as` (an identity) and optionally `policy` (a candidate file) it decides offline and sends nothing. | read-only |
| `verb_list` | Lists the verbs by layer (`user`, `proj`, `org`) with description, tags and parameters, marks those a closer layer overrides, and names files refused at load. | read-only |
| `verb_run` | Runs one `verb` with `args`, or with `tag` every verb carrying that tag (each with its defaults, in address order). Returns per verb passed, failed or skipped, with each statement's decision and outcome. | changes data; runs code |

Use `policy_check` first to see what the policy would decide. A query in `run_script` or `verb_run` has the same time limit and runaway check as `run_sql`; past the limit the session is reset.

### Verbs

`verb_list` and `verb_run` work with verbs: YAML files in three layers (`user`, `proj` with the profile's `IBMI_KIT_VERBS`, `org` beside the policy), loaded once per server on its first verb call. Every statement of a call is decided as one script, with the same profile checks, confirmation and run log as `run_script`. The file format, layers, how a run is decided and run, suites and connection resets are in [docs/verbs.md](../../docs/verbs.md).

### Confirmation

A rule with `decision: confirm` makes `run_script`, `verb_run`, a guarded source tool, or `screen_do`, `run_tests` and `session_open` ask the user once, through MCP elicitation, listing every statement that needs it. Only an accepted form with `confirm: true` runs it. A client without elicitation support, a decline, a cancel or no answer within 120 seconds all deny. The server writes one line to stderr per client saying whether confirmation is available.

### Policy, partition and run log

- Each profile may set `IBMI_KIT_POLICY` (absolute path) to a policy file; unset means the built-in observe policy. Every listed profile's policy is loaded at startup, so a missing or invalid file stops the server and names it. A profile added later loads on first use.
- `IBMI_PARTITION` in the profile declares the partition; it must agree with what the 5250 System name and the SQL RDB name map to. The System name is the sign-on screen's `System` field, read when `session_open` connects; until a session has read it, the RDB name and the declaration decide.
- The source engine's tools are decided through a hook the server passes to it: `run_sql`, `read_source_member` and `search_source` as reads, `upload_source_member` as a write, `manage_library_list` changes as `liblist`, and `compile_member` from its final command plus, for an SQL member or `RUNSQLSTM`, the member's statements read at decision time. A denied or unconfirmed call fails before the engine sends anything; the engine's own checks still apply. The call's outcome (`ok`, or `failed:` with the reason) is logged once the engine finishes.
- The screen engine gets the same hook: before `screen_do` or `run_tests` sends a key that carries field data, the command line's text at that moment (typed or retrieved with F9) is decided as CL (logged as tool `screen_command`; F4 is decided as `?command`, so always denied), and `session_open` decides its sign-on program as `call` and library as `liblist` after reading the System name and before signing on. The engine's own sign-on, recovery and sign-off keys are not decided. The screen engine's restricted mode and `IBMI_BLOCKED_CL` check the same text first. A command line runs in the 5250 job, so `*CURLIB` there is unqualified and a write through a `QTEMP` alias or view is denied; a digits-only menu option on it is not decided.- `run_script`, `verb_run`, guarded source tool and 5250 decisions are logged to `runs/YYYY-MM-DD.jsonl` in the first folder in `CONFIG_DIRS()`, so `~/.ibmi-agent-kit/runs` unless `IBMI_KIT_CONFIG_DIR` (or the older `IBMI_MCP_CONFIG_DIR`) is set. See the [guard README](../guard/README.md#run-log).
- Identity is read once per server from the catalog. When that fails (a profile without a working SQL connection), the profile's user decides with `default_role`, the run log notes the failed lookup, and it is retried after a minute. If the job is lost or reset (for example after the query time limit), later statements are refused rather than sent on a new job.
- The profile's own checks (`IBMI_READ_ONLY`, `IBMI_BLOCKED_TABLES`, `IBMI_BLOCKED_CL`, the runaway check) apply in every mode and also refuse.

## `policy` command

```sh
node <repo>/packages/server/dist/index.js policy test <policy> <tests>
node <repo>/packages/server/dist/index.js policy replay <candidate-policy> [--since <days>]
```

`npm link -w packages/server` puts `ibmi-agent-kit` on PATH so you can shorten the command. Offline, no IBM i, output on stdout. Details in the [guard README](../guard/README.md#offline-policy-test-and-policy-replay).

## Logging and shutdown

- stdout is the JSON-RPC channel. The server redirects `console.log`, `console.info` and `console.debug` to stderr; engines write nothing to stdout.
- Unhandled rejections and exceptions are logged to stderr, not fatal.
- Shutdown runs once on SIGINT, SIGTERM, stdin end or transport close: every engine signs off at once, bounded to 5 seconds, then the process exits 0 after the last stderr line is written. Windows sends no SIGTERM when a parent ends the child, which is why stdin end is a trigger.
- A tool name two engines both register stops the server at startup, naming the tool.

## Tests

`src/selfcheck.ts` (which also loads `src/verbs-selfcheck.ts`), run by `npm run check` from the repo root. Stub transports, no IBM i. Running `run_script`, `verb_run` and `policy_check` against PUB400 has not been done yet.

Back to the [root README](../../README.md).
