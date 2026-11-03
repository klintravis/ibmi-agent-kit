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
| `list_servers` | Lists the configured servers (the `.env.<name>` files), the open 5250 sessions on each, and the profile folders searched. With no profile it also offers a first-profile [sign-on page](#sign-on-page). | read-only |
| `run_script` | Runs SQL statements (`;` separated) and CL commands (lines starting `CL:`) in order. Every statement is classified and decided, and every confirmation asked, before the first is sent: one denied statement or a declined confirmation sends nothing. Stops at the first failure. Returns per statement the decision, outcome, rows affected, rows (up to `maxRows`, default 100, at most 1000) and messages. | changes data; runs code |
| `policy_check` | Decides a `script`, or every statement a `verb` (with `args`) would send, without running it: per statement the operations with library, partition, environment and class, the matching rule and the decision, plus `warnings` for a CL command given a parameter its command-table entry does not name (the decision is unchanged). Sends only the catalog lookups needed. With `as` (an identity) and optionally `policy` (a candidate file) it decides offline and sends nothing. | read-only |
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

`npm link -w packages/server` puts `ibmi-agent-kit` on PATH so you can shorten the command. Offline, no IBM i, output on stdout. `policy test` prints `warning: <case>: <warning>` on stderr for each CL command given a parameter its command-table entry does not name when the value names a library or object ([details](../../docs/policy.md#test-a-policy)); warnings never change the exit code. `policy test` also loads the project and policy verbs and exits 1 when any verb file would be refused, even if no case names a verb (2 when a case names the refused verb). Details in the [guard README](../guard/README.md#offline-policy-test-and-policy-replay).

## Passwords

A profile holds no password. It names where the password comes from, and the kit fetches it only when it is about to sign on, never when it merely reads the profile (`list_servers`, the policy path, verb lookups).

| Profile line | The password comes from |
|---|---|
| `IBMI_PASSWORD_STORE=os` | the OS credential store: Windows Credential Manager, macOS Keychain, Linux Secret Service. The entry has service `ibmi-agent-kit` and account `USER@host` (user upper case, host lower case), so two profiles for one user and box share an entry, and a host edited by hand finds no entry instead of sending the old password to the new box |
| `IBMI_PASSWORD_COMMAND=<command>` | the standard output of a helper program you name |
| `IBMI_PASSWORD=<text>` | the file itself. Still works, with a warning; see below |

Both new keys are read from the profile file only; the process environment cannot set them. When a profile sets more than one, the order is helper, then store, then plain line. The kit never falls back: if the helper fails, the connection fails and the plain line is not tried, because a stale password would cost a sign-on attempt.

**Choose a source at `setup`.** At the "password source" prompt press Enter (or type `os`) for the OS store and then type the password, hidden, or type a helper command. When the profile already has a helper for the same host and user, Enter keeps it. See [`setup` command](#setup-command). In a company config repo each person makes this choice; the repo never supplies one.

**Or use the page.** A store profile with no entry, or whose password was rejected, is offered a one-time [sign-on page](#sign-on-page) in your browser.

**Rotate a password.**

```sh
node <repo>/packages/server/dist/index.js credential set <profile>
node <repo>/packages/server/dist/index.js credential delete <profile>
```

`credential set` asks for the password (hidden), or reads one line of standard input when it is not a terminal, and stores it for the profile's user and host. It never takes the password as an argument (a password on the command line exits 2 and stores nothing) and never changes the profile file. It prints a note when the profile does not set `IBMI_PASSWORD_STORE=os`, because the kit would not read that entry. `credential delete` removes the entry. Usage errors and store failures exit 2. A running server picks up the new value at its next sign-on, with no restart; a session already signed on is not affected. Change the password on the IBM i and in the store back to back: a sign-on in between sends the old one and counts as one failed attempt. With a helper, change the secret wherever the helper reads it.

There is no `credential get`, on purpose: the kit offers no command that prints a stored password for an agent with a shell to run. That is not a defence against a process running as you, which can still read the store with the OS's own tools or run your helper.

**An existing `IBMI_PASSWORD` line still works.** The first time the kit signs on with it, it writes one warning per process and profile file to standard error: `<file> holds a plain IBMI_PASSWORD. Run ibmi-agent-kit setup to move it to the OS store`. The warning names the file, never the value. If a helper or store is also set, the plain line is ignored and the warning says to remove it and change that password. `setup` always removes the plain line, and refuses a helper command when the profile file is inside a git work tree. If the host and user are unchanged and you press Enter at both the source and the password prompt, the old password moves into the OS store; if you type a helper command instead, the old password is dropped, not moved.

**Errors.** A missing store entry names the account it looked for. A store that cannot be read or written, or a native module that cannot load on this platform, is an error that points at `credential set` or `IBMI_PASSWORD_COMMAND`. `list_servers`, tool output, the run log and the 5250 viewer never show the password; the run log masks the last password fetched for the connection's user and host.

### Helper command

The value is an executable and its arguments. The kit runs it with no shell.

- Splitting: whitespace separates arguments outside double quotes; a double quote toggles quoting and is removed; a backslash and a single quote are literal; an unterminated quote is an error. A Windows path with spaces just goes in double quotes.
- A first token ending `.cmd`, `.bat` or `.ps1` is refused before it runs, because that needs a shell. Run a script as `powershell -NoProfile -File <script>`.
- It runs with your home folder as the working directory, no standard input, its standard error discarded, a 30 second timeout and at most 64 KiB of output. The password is its standard output as UTF-8, with a leading BOM and one trailing line ending removed. Trailing spaces are kept, and empty output is an error. Use an absolute path to the executable.
- It runs for every sign-on and the result is not cached: once per attempt to send the password, including a 5250 sign-on retry. Keep it quick. While a sign-on waits on a slow helper, other sign-ons for the same user and host wait behind it.
- A failure (non-zero exit, timeout, too much output, cannot start) stops that sign-on with an error that names only the executable and the reason. Its output and arguments are never in the message, and it is not retried.
- A helper line is refused when the real path of the profile file has a `.git` entry in its folder or any parent, because a pulled change could add a command. The check runs at sign-on, so reading the profile still works. `IBMI_PASSWORD_STORE=os` works anywhere. Limit: a home folder that is itself a dotfiles repository is refused too; use the store or a profile folder outside it (`IBMI_KIT_CONFIG_DIR`).

**Writing the value in the file.** `setup` writes it correctly for you. By hand, wrap the whole value in single quotes:

```ini
IBMI_PASSWORD_COMMAND='"C:\Program Files\Tools\get-pw.exe" --target ibmi/dev'
```

dotenv (the profile parser) expands `\n` and `\r` inside double quotes, so `"C:\new\x.exe"` becomes a line break in the middle of the path, and an unquoted `#` starts a comment. Single quotes keep both literally. If the command itself holds a single quote, wrap it in backticks instead; `setup` picks a wrapper the value does not contain on its own (double quotes only when the value has no `\n` or `\r` sequence) and refuses a value it cannot wrap, such as one holding `'`, a backtick and `"`.

**What you type at the `setup` prompt is visible.** The helper command is echoed in the terminal (the password prompt is hidden, this one is not), is stored in the profile file as typed, and its arguments show in the process list while it runs. It should hold no secret: name a program that fetches the secret, never put the password in the command.

**Windows Credential Manager example.** This uses the third-party `CredentialManager` PowerShell module (`Install-Module CredentialManager`), which is not part of the kit or of Windows. It has not been tested live. Store a generic credential with the target `ibmi/dev`, save this as `C:\tools\get-ibmi-password.ps1`:

```powershell
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$c = Get-StoredCredential -Target 'ibmi/dev'
if (-not $c) { exit 3 }
[Console]::Out.Write($c.GetNetworkCredential().Password)
```

and set:

```ini
IBMI_PASSWORD_COMMAND='powershell -NoProfile -File "C:\tools\get-ibmi-password.ps1"'
```

Run the script by hand first: the encoding line matters, because Windows PowerShell 5.1 would otherwise pipe in the OEM code page and a mangled password is a wrong password, which costs a sign-on attempt. Under PowerShell constrained language mode the script may be blocked; use the OS store there.

**Linux.** The store needs a running, unlocked Secret Service (for example GNOME Keyring or KWallet) reachable over D-Bus. The kit does not fall back to the kernel keyring, which is lost at restart. A headless server, container, CI job or WSL without a Secret Service gets an error and nothing is stored; use a helper there. The module's Linux binaries link libdbus (`AFL-2.1 OR GPL-2.0-or-later`), which may matter to your licence review.

### A wrong password is sent once

IBM i disables a user profile after `QMAXSIGN` failed sign-ons, so the kit tries a rejected password once. For each user and host, a password the box rejected is remembered for the life of the server process, at every place that signs on (SSH, the Mapepire daemon, 5250). The next attempt fetches the password and, if it is the same one, fails without sending, saying to change it in the store or helper, or to restart the server to try it again. A different password is sent, and an accepted sign-on clears the record. Sign-ons for one user and host run one at a time, so a second tool call sees the first one's result.

Limits, plainly:

- **Per process, not per box.** The record lives in memory, on purpose: writing it to disk would store data derived from the password. Every separate process sends the wrong password once: two MCP clients on the same profile, the same user's profile on two machines, or a client plus a `setup` run (its own process). Together they can still reach `QMAXSIGN`, so fix the password before restarting clients or running `setup` again.
- **Only an authentication failure counts.** An SSH `client-authentication` failure, a 5250 sign-on failure or sign-on screen still showing after Enter, or a Mapepire daemon error showing "Unexpected server response: 401" or the whole word "authentication" (a host name containing that word, such as `authentication-gw.corp` or `gw.authentication.corp`, does not match; only a host named exactly `authentication` can). A host that is down is not recorded. The daemon's wording on a wrong password has not been confirmed against a live box: if it differs, nothing is recorded for the daemon and the old behaviour (a send per attempt) remains.
- **Only the last rejected value.** Changing to a different wrong password sends it, and costs an attempt.
- **A restart clears the record**, and the 5250 check can misfire on a slow screen; the refusal message names the restart as the way to try again.

Not yet verified against real systems: the OS store on Windows, macOS and Linux (the selfchecks use a fake store and a fake helper), and a Mapepire daemon's response to a wrong password.

A store profile gets one more chance through the [sign-on page](#sign-on-page): after a rejection the next error offers the page once per user and host, and a second wrong password ends it.

## Sign-on page

A person can give the server a password, or create a first profile, on a one-time page in their own browser, with no command line. The server serves it on `127.0.0.1` only, from `signon-page.ts`, and only while the stdio server runs. `setup` and `credential` are separate processes and serve no page; the standalone screen and source servers serve none either.

**When it is offered.** The tool call that needs it fails at once, without sending anything, and the error holds the offer. It does not wait for the page.

| Situation | Offer |
|---|---|
| A `IBMI_PASSWORD_STORE=os` profile has no stored entry | a page for that user and host |
| The stored password was rejected (see [A wrong password is sent once](#a-wrong-password-is-sent-once)) | one more page, see below |
| No profile exists and `list_servers` runs | a first-profile page (host, user, password; in a [company config repo](#in-a-company-config-repo) the host and partition come from the skeleton); `default` is the profile name, or the partition's name in a company repo. An unknown server name with no profile listed says that `list_servers` offers it |
| A helper (`IBMI_PASSWORD_COMMAND`) or plain `IBMI_PASSWORD` profile | none; the existing error stands |
| A profile with no password source | none; it keeps its load error |
| A store that cannot be read (for example Linux without a Secret Service) | none; the existing store error stands |

With profiles present, a mistyped server name stays the usual `Available: ...` error. `list_servers` stays read-only: opening the listener writes nothing, and only a person's submission does.

**How it reaches the person.** If the client declares URL elicitation, the server asks it to open the page, once per page, and the first error says a prompt was offered, without the link. The link is printed in the error when the client does not support URL elicitation, declines or fails the request, or has not answered within 10 seconds of the offer. Form-mode elicitation is never used. Whether the VS Code extension shows the prompt is not verified; the printed link is the fallback. The error also names `ibmi-agent-kit setup` and `ibmi-agent-kit credential set <profile>`.

**What the page does.** It names the host and the user, escaped, and warns that a wrong password counts as a failed sign-on toward `QMAXSIGN`. The password goes only to the OS credential store: not to the client, the model, the log or the IBM i. Submitting sends nothing to the IBM i and does not say whether the password is right. The next tool call fetches it and signs on, once. A first-profile submission writes the profile by the rules of `setup` (store first, then the file; `IBMI_PASSWORD_STORE=os`, no password in the file; mode 600 in a folder with mode 700 on macOS and Linux). From a skeleton it copies every setting except the user, password, helper, store and policy lines, and sets the policy path to the repo's `policy.yaml`. It refuses a profile folder inside a git work tree or the company repo, and never overwrites a profile that has appeared since the offer.

**Protections.** Loopback bind on a random port, opened on the first offer and closed when no page is left; a Host check (a name that is not loopback is refused); a random 128-bit token that expires after 5 minutes and dies on the first accepted submission; a GET shows the form and does not use the token; a submission is a POST with the token in its body, 4 KiB at most, and a foreign `Origin` is refused; nothing is read from the URL but the token. Every response, refusals included, sends `cache-control: no-store`, a content security policy with `frame-ancestors 'none'` and no script, and `referrer-policy: no-referrer`. The link holds only the address and the token.

**Limits.**

- **Each wrong password costs a real sign-on attempt** toward `QMAXSIGN`, which the kit cannot see. The page offers one re-offer after a rejected password, per user and host, per server process: the first wrong password, then one more page, then no page and the error names `credential set` and the restart. Two MCP clients are two processes and count separately, so together they can spend more attempts. A page that expires unused does not count.
- **The submission does not try the password.** Ask the assistant to try again.
- **An agent holding the printed link can submit a value**, including a wrong one, if it has a shell or a web tool. The error tells the model to hand the link to the user and not to open it. The page stores the value and says nothing about whether it is right, takes only one accepted submission per link, and is bounded by the re-offer limit above. When the client elicits, the link does not go through the model.
- **Where the page cannot work.** The link points at the server's own loopback, so a headless, remote or container session cannot open it; there is no non-loopback option. Use `ibmi-agent-kit setup` or `ibmi-agent-kit credential set <profile>` there. On Linux without a Secret Service the store write fails, the page says so and points at `IBMI_PASSWORD_COMMAND`, and nothing is written; there is no in-memory fallback.
- Not verified live: any client's handling of the prompt, and the OS store on each platform.

## `setup` command

```sh
node <repo>/packages/server/dist/index.js setup [name]
```

Writes or updates one profile and tests it. It is the terminal route for sessions where the [sign-on page](#sign-on-page) cannot work. No name means `default`, so the file is `.env`; any other name writes `.env.<name>`. The file goes in the first profile folder: `IBMI_KIT_CONFIG_DIR` if set, else `~/.ibmi-agent-kit`, created if missing.

1. It asks for the host and the user. If the file already exists, its values are shown in brackets and Enter keeps them.
2. It asks for the password source (see [Passwords](#passwords)): Enter or `os` for the OS store, or a helper command, which is echoed because it is not secret. A host or user that differs from the file never keeps the current source. For the store it then asks for the password without showing it. Enter keeps the stored (or old plain) one only when the host and user are unchanged; otherwise `setup` asks for a new password. The store is written first; if that fails, the profile file stays as it was. The profile ends with exactly one source and no `IBMI_PASSWORD` line. A helper command is refused, writing nothing, when it is a `.cmd`, `.bat` or `.ps1` file or the profile file is inside a git work tree. Backspace edits, and Ctrl-C quits without writing anything.
3. It asks for a policy file. One pair of surrounding quotes is dropped, a leading `~` expands to your home folder and a relative path is stored as an absolute `IBMI_KIT_POLICY`. The policy is loaded before anything is saved: if it is missing or invalid, `setup` prints the reason, writes nothing and exits 2. Enter leaves the setting as it is.
4. It saves the file. It replaces only those settings and keeps every other line and comment. The write goes through a temp file and a rename, so you never get a half-written profile. On macOS and Linux the file gets mode `600`.
5. It reads the profile back from the file, and, if the file already held a policy, loads that. It then connects the way the server does and runs `SELECT CURRENT USER, CURRENT SERVER FROM SYSIBM.SYSDUMMY1`. It prints one line: `OK: <name> signs on as <user> to <rdb>`, or `failed:` with the reason. A failed test keeps the file and exits 1.

Notes:

- Run it yourself in a real terminal: PowerShell, Windows Terminal, macOS Terminal or a Linux shell. Without a terminal it refuses and writes nothing. That includes running it through Claude, through a pipe, or in Git Bash's mintty window.
- The password is never taken as an argument and never printed. It is cut from any connection error before that error is shown.
- Names follow the profile rules: letters, digits, `.`, `_` and `-`, starting with a letter or digit. A name cannot be `example`, contain `..`, end in `.`, or end in `.bak` or `.orig`. On Windows and macOS, a name that matches an existing profile except for case is refused, so it can't overwrite that profile.
- dotenv cannot store a value that contains a line break, or that contains `'`, `"` and a backtick all at once. Setup refuses such a value instead of saving it wrong.
- Setup never writes a password to the profile file; the OS store or a helper command holds it.
- The test connects like any session would. Over `ssh`, that can mean uploading the Mapepire jar the first time.

### In a company config repo

When the current folder holds both `policy.yaml` and a `profiles/` folder (a company config repo made by the `ibmi-kit-config` skill), `setup` takes the company's settings from the repo and asks only for yours. Folders above the current one are not searched.

- The partitions are the `profiles/.env.<partition>` skeletons, listed by the same rules as profile names. With one skeleton it is taken; with several, setup lists them and asks for a number or a name. A name on the command line must be one of them, else setup exits 2.
- It copies every setting of the skeleton (host, partition, transport, ports, guards) into your profile, except `IBMI_USER`, `IBMI_PASSWORD`, `IBMI_PASSWORD_COMMAND`, `IBMI_PASSWORD_STORE` and `IBMI_KIT_POLICY`. A skeleton without `IBMI_HOST` or `IBMI_PARTITION` is refused (exit 2).
- It prints the skeleton's partition and host, then asks for your user and your password source, as above. Each person chooses; the repo never supplies one. It does not ask for a host or a policy.
- If your profile already points at another host, setup says the host is replaced and asks for a new password: Enter does not keep the old host's password.
- `IBMI_KIT_POLICY` is set to the repo's `policy.yaml` as an absolute path, after the same policy check. A different policy path already in your profile is replaced, and setup says so.
- A password in a skeleton is never copied: setup warns you to remove it from the repo and change it. A helper command in a skeleton is never copied or run either; setup warns you to remove it.
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
