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

A rule with `decision: confirm` makes `run_script`, `verb_run`, a guarded source tool, or `screen_do`, `run_tests` and `session_open` ask the user once, through MCP elicitation, listing every statement that needs it (one exception: after a confirmed read of an SQL member, `compile_member` fetches the member and asks again for any of its statements that need it). Only an accepted form with `confirm: true` runs it. A client without elicitation support, a decline, a cancel or no answer within 120 seconds all deny. The server writes one line to stderr per client saying whether confirmation is available.

### Policy, partition and run log

- Each profile may set `IBMI_KIT_POLICY` (absolute path) to a policy file; unset means the built-in observe policy. Every listed profile's policy is loaded at startup, so a missing or invalid file stops the server and names it. A profile added later loads on first use.
- `IBMI_PARTITION` in the profile declares the partition; it must agree with what the 5250 System name and the SQL RDB name map to. The System name is the sign-on screen's `System` field, read when `session_open` connects; until a session has read it, the RDB name and the declaration decide.
- The source engine's tools are decided through a hook the server passes to it: `run_sql`, `read_source_member` and `search_source` as reads, `upload_source_member` as a write, `manage_library_list` changes as `liblist`, and `compile_member` from its final command plus, for an SQL member or `RUNSQLSTM`, the member's statements read at decision time (a member whose read is denied is never fetched; one whose read needs confirming is fetched only after a yes, so that prompt shows none of its lines). A denied or unconfirmed call fails before the engine sends anything; the engine's own checks still apply. The call's outcome (`ok`, or `failed:` with the reason) is logged once the engine finishes.
- The screen engine gets the same hook: before `screen_do` or `run_tests` sends a key that carries field data, the command line's text at that moment (typed or retrieved with F9) is decided as CL (logged as tool `screen_command`; F4 is decided as `?command`, so always denied), and `session_open` decides its sign-on program as `call` and library as `liblist` after reading the System name and before signing on. The engine's own sign-on, recovery and sign-off keys are not decided. The screen engine's restricted mode and `IBMI_BLOCKED_CL` check the same text first. A command line runs in the 5250 job, so `*CURLIB` there is unqualified and a write through a `QTEMP` alias or view is denied; a digits-only menu option on it is not decided.
- `run_script`, `verb_run`, guarded source tool and 5250 decisions are logged to `runs/YYYY-MM-DD.jsonl` in the first folder in `CONFIG_DIRS()`, so `~/.ibmi-agent-kit/runs` unless `IBMI_KIT_CONFIG_DIR` (or the older `IBMI_MCP_CONFIG_DIR`) is set. See the [guard README](../guard/README.md#run-log).
- Identity is read once per server from the catalog. When that fails (a profile without a working SQL connection), the profile's user decides with `default_role` for that call, the run log notes the failed lookup, and the next call reads it again: only a successful lookup is kept. If the job is lost or reset (for example after the query time limit), later statements are refused rather than sent on a new job.
- The profile's own checks (`IBMI_READ_ONLY`, `IBMI_BLOCKED_TABLES`, `IBMI_BLOCKED_CL`, the runaway check) apply in every mode and also refuse.

## `policy` command

```sh
node <repo>/packages/server/dist/index.js policy test <policy> <tests>
node <repo>/packages/server/dist/index.js policy replay <candidate-policy> [--since <days>]
```

`npm link -w packages/server` puts `ibmi-agent-kit` on PATH so you can shorten the command. Offline, no IBM i, output on stdout. `policy test` also loads the project and policy verbs and exits 1 when any verb file would be refused, even if no case names a verb (2 when a case names the refused verb). Details in the [guard README](../guard/README.md#offline-policy-test-and-policy-replay).

## `setup` command

```sh
node <repo>/packages/server/dist/index.js setup [name]
```

Writes or updates one profile and tests it. No name means `default`, so the file is `.env`; any other name writes `.env.<name>`. The file goes in the first profile folder: `IBMI_KIT_CONFIG_DIR` if set, else `~/.ibmi-agent-kit`, created if missing.

1. It asks for the host and the user. If the file already exists, its values are shown in brackets and Enter keeps them.
2. It asks for the password without showing it. Enter keeps the current one. Backspace edits, and Ctrl-C quits without writing anything.
3. It asks for a policy file. One pair of surrounding quotes is dropped, a leading `~` expands to your home folder and a relative path is stored as an absolute `IBMI_KIT_POLICY`. The policy is loaded before anything is saved: if it is missing or invalid, `setup` prints the reason, writes nothing and exits 2. Enter leaves the setting as it is.
4. It saves the file. It replaces only those settings and keeps every other line and comment. The write goes through a temp file and a rename, so you never get a half-written profile. On macOS and Linux the file gets mode `600`.
5. It reads the profile back from the file, and, if the file already held a policy, loads that. It then connects the way the server does and runs `SELECT CURRENT USER, CURRENT SERVER FROM SYSIBM.SYSDUMMY1`. It prints one line: `OK: <name> signs on as <user> to <rdb>`, or `failed:` with the reason. A failed test keeps the file and exits 1.

Notes:

- Run it yourself in a real terminal: PowerShell, Windows Terminal, macOS Terminal or a Linux shell. Without a terminal it refuses and writes nothing. That includes running it through Claude, through a pipe, or in Git Bash's mintty window.
- The password is never taken as an argument and never printed. It is cut from any connection error before that error is shown.
- Names follow the profile rules: letters, digits, `.`, `_` and `-`, starting with a letter or digit. A name cannot be `example`, contain `..`, end in `.`, or end in `.bak` or `.orig`. On Windows and macOS, a name that matches an existing profile except for case is refused, so it can't overwrite that profile.
- dotenv cannot store a value that contains a line break, or that contains `'`, `"` and a backtick all at once. Setup refuses such a value instead of saving it wrong.
- The test connects like any session would. Over `ssh`, that can mean uploading the Mapepire jar the first time.

### In a company config repo

When the current folder holds both `policy.yaml` and a `profiles/` folder (a company config repo made by the `ibmi-kit-config` skill), `setup` takes the company's settings from the repo and asks only for yours. Folders above the current one are not searched.

- The partitions are the `profiles/.env.<partition>` skeletons, listed by the same rules as profile names. With one skeleton it is taken; with several, setup lists them and asks for a number or a name. A name on the command line must be one of them, else setup exits 2.
- It copies every setting of the skeleton (host, partition, transport, ports, guards) into your profile, except `IBMI_USER`, `IBMI_PASSWORD` and `IBMI_KIT_POLICY`. A skeleton without `IBMI_HOST` or `IBMI_PARTITION` is refused (exit 2).
- It prints the skeleton's partition and host, then asks for your user and your password (hidden), as above. It does not ask for a host or a policy.
- If your profile already points at another host, setup says the host is replaced and asks for a new password: Enter does not keep the old host's password.
- `IBMI_KIT_POLICY` is set to the repo's `policy.yaml` as an absolute path, after the same policy check. A different policy path already in your profile is replaced, and setup says so.
- A password in a skeleton is never copied: setup warns you to remove it from the repo and change it.
- Your password goes only in your profile folder. If that folder, or a profile file linked from it, lies inside the repo, setup refuses before asking anything and writes nothing.
- Setup reads the repo and never writes to it.
- If the repo's `.mcp.json` starts the kit from `${IBMI_KIT_HOME}` and that variable is not set, setup prints the kit folder to set it to.

## Logging and shutdown

- stdout is the JSON-RPC channel. The server redirects `console.log`, `console.info` and `console.debug` to stderr; engines write nothing to stdout.
- Unhandled rejections and exceptions are logged to stderr, not fatal.
- Shutdown runs once on SIGINT, SIGTERM, stdin end or transport close: every engine signs off at once, bounded to 5 seconds, then the process exits 0 after the last stderr line is written. Windows sends no SIGTERM when a parent ends the child, which is why stdin end is a trigger.
- A tool name two engines both register stops the server at startup, naming the tool.

## Tests

`src/selfcheck.ts` (which also loads `src/verbs-selfcheck.ts` and `src/setup-selfcheck.ts`), run by `npm run check` from the repo root. Stub transports, no IBM i. `run_script`, `verb_run` and `policy_check` have also run on PUB400 as a normal user (see the archived execution-guard and project-verbs tasks). `setup` has not run against a real IBM i yet.

Back to the [root README](../../README.md).
