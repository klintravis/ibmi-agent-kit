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
| `policy_check` | Decides a script without running it: per statement the operations with library, partition, environment and class, the matching rule and the decision. Sends only the catalog lookups needed. With `as` (an identity) and optionally `policy` (a candidate file) it decides offline and sends nothing. | read-only |

Use `policy_check` first to see what the policy would decide. A query in `run_script` has the same time limit and runaway check as `run_sql`; past the limit the session is reset.

### Confirmation

A rule with `decision: confirm` makes `run_script` ask the user once, through MCP elicitation, listing every statement that needs it. Only an accepted form with `confirm: true` runs it. A client without elicitation support, a decline, a cancel or no answer within 120 seconds all deny. The server writes one line to stderr per client saying whether confirmation is available.

### Policy, partition and run log

- Each profile may set `IBMI_KIT_POLICY` (absolute path) to a policy file; unset means the built-in observe policy. Every listed profile's policy is loaded at startup, so a missing or invalid file stops the server and names it. A profile added later loads on first use.
- `IBMI_PARTITION` in the profile declares the partition; it must agree with what the 5250 System name and the SQL RDB name map to. The 5250 System name is not yet read by the guard (a stub), so today the RDB name and the declaration decide.
- Decisions are logged to `<first profile folder>/runs/YYYY-MM-DD.jsonl`. See the [guard README](../guard/README.md#run-log).
- The job's identity (user, groups, authorization lists) is read once per connection from the catalog, not decided. If a script changes the job, `run_script` refuses to send on a different job from the one it decided against.
- The profile's own checks (`IBMI_READ_ONLY`, `IBMI_BLOCKED_TABLES`, `IBMI_BLOCKED_CL`, the runaway check) apply in every mode and also refuse.

## `policy` command

```sh
ibmi-agent-kit policy test <policy> <tests>
ibmi-agent-kit policy replay <candidate-policy> [--since <days>]
```

Offline, no IBM i, output on stdout. Details in the [guard README](../guard/README.md#offline-policy-test-and-policy-replay).

## Logging and shutdown

- stdout is the JSON-RPC channel. The server redirects `console.log`, `console.info` and `console.debug` to stderr; engines write nothing to stdout.
- Unhandled rejections and exceptions are logged to stderr, not fatal.
- Shutdown runs once on SIGINT, SIGTERM, stdin end or transport close: every engine signs off at once, bounded to 5 seconds, then the process exits 0 after the last stderr line is written. Windows sends no SIGTERM when a parent ends the child, which is why stdin end is a trigger.
- A tool name two engines both register stops the server at startup, naming the tool.

## Tests

`src/selfcheck.ts`, run by `npm run check` from the repo root. Stub transports, no IBM i. Running `run_script` and `policy_check` against PUB400 has not been done yet.

Back to the [root README](../../README.md).
