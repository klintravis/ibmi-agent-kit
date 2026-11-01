# Design

## Context

`policy` is the server binary's only subcommand today (`src/index.ts` dispatches on `argv[2]` to
`policy-cli.ts`, which takes injected writers and returns an exit code). Core owns the profile
folders (`CONFIG_DIRS`), the file-name rules (`serverName`), `listServers` and `resolveProfileEnv`,
which parses with `dotenv` 16. The source engine owns `loadProfile` and the Mapepire transport
behind `MapepireBackend`.

`config-bootstrap` (the `ibmi-kit-config` skill) and `demo-quickstart` (the `demo` skill and
`docs/demo.md`) were still open when this change started and were archived on `main` while it was
in progress. This change adds requirements to those two capabilities and leaves their existing ones
alone. It edits only the parts named here: Bootstrap step 1, and the demo's profile, connect and
Part D steps.

## Goals / Non-Goals

**Goals:** one interactive command that leaves a working, tested profile; nothing a user must find
or edit by hand on the first run.

**Non-Goals:** a general profile editor; a non-interactive mode; secrets storage beyond the file.

## Decisions

- **Same shape as `policy`.** `setupCli(args, deps)` returns the exit code; `deps` carries stdin,
  the two writers and `connect(env)`. Production `connect` is
  `new MapepireBackend(loadProfile(env))`; the selfcheck passes a fake. `index.ts` sets the exit
  code and arms an unref'd one-second `process.exit`, so a lingering ssh handle cannot keep the
  process alive and output is never cut short.
- **Name check and parser reuse core.** `serverName` and `parseProfile` (the `dotenv` parse that
  `resolveProfileEnv` now calls) are exported, and `setup` requires
  `serverName(file) === name` (so `example`, `default` as a suffix, `.bak`, `.orig` behave exactly as
  the loader does), plus a charset `[A-Za-z0-9][A-Za-z0-9._-]*`, no `..`, no trailing `.` (Windows
  drops it). Alternative, a separate rule list in the server: rejected, it would drift.
- **One raw-mode reader for every prompt.** Visible prompts echo, the password does not; both handle
  Enter, Backspace and Ctrl-C, keep unread pasted characters for the next prompt, and restore raw
  mode in a `finally`. stdin not a TTY is refused before the first prompt (no echo fallback). Git
  Bash's mintty is not a TTY to Node, so the docs say PowerShell or Windows Terminal there.
  shortcut: escape sequences (arrow keys) are dropped as a whole chunk, not edited.
- **dotenv quoting by choice of quote, then proof.** dotenv 16 unescapes nothing inside quotes and
  expands `\n`/`\r` inside double quotes, so a value is wrapped in the first of `'`, `` ` ``, `"` it
  does not contain (`"` only without `\n`/`\r` sequences); CR, LF or NUL, or all three quotes, are
  refused. The new text is then parsed with the same loader rules and must give back every new value
  and every other key unchanged, or nothing is written. Alternative, backslash escaping: dotenv does
  not read it back.
- **Update in place.** Every line that sets the key (dotenv's `KEY=`, `export KEY=`, `KEY:` forms;
  the last one wins on read) is replaced; a missing key is appended. Line endings follow the file.
- **Answers first, disk second.** All prompts finish before anything is written, so Ctrl-C leaves
  no file. Write: `mkdir -p` (0700), temp file `setup-<pid>-<rand>.tmp` (not `.env.*`, so it is never
  listed) with `wx` and 0600, rename over the target, unlink the temp on failure.
- **Empty answers.** Host and user: Enter keeps the current value, and is asked again when there is
  none. Password: Enter keeps the existing one on an update. Policy: Enter leaves it as is.
- **Test reads the file, not memory.** `resolveProfileEnv(name)` then `listServers()`; if the profile
  sets `IBMI_KIT_POLICY`, `loadPolicy` must accept it (a bad policy stops the server at startup);
  then the SELECT. The result line names user and RDB on success, or the reason on failure, with the
  password (raw, JSON-escaped, URI-encoded) removed. Exit 0 or 1; usage errors and refusals exit 2;
  Ctrl-C exits 130.
- **A later folder with the same name.** When `~/.ibm-i-servers` (or another later folder) also holds
  the file, `setup` says its new file takes precedence; it does not copy settings across.
- **Re-enabling a project server** (Claude Code docs, `mcp.md` "Server status" and
  `settings-reference.md#disabledmcpjsonservers`): a rejection is stored as `disabledMcpjsonServers`
  in the project's local settings and `claude mcp get` shows `✘ Rejected`; `claude mcp
  reset-project-choices` resets approval choices; "Pending approval" is approved by running `claude`
  interactively; "Disabled for this project" is turned back on from `/mcp`. The docs do not say
  the reset clears `disabledMcpjsonServers`, so the skill falls back to removing the name there.
- **Bootstrap folder check.** Order: this kit's `policy.yaml` → Maintain; only `.git`, `README*`,
  `LICENSE*`, `.gitignore` → bootstrap; anything else → refuse, naming the entries. The session's
  own Claude Code files are also allowed: a `.mcp.json` registering ibmi-agent-kit and a `.claude`
  folder holding only `skills/` and `settings.local.json`. `docs/demo.md` Part D copies the first
  two in, and approving the server writes the third, so without them the demo's own bootstrap
  would be refused. The kit path in step 1 comes from `claude mcp get ibmi-agent-kit`, as in `/demo`.

## Risks / Trade-offs

- [The ssh transport uploads the Mapepire jar on first connect] → the same as any first connection;
  the README says so.
- [A transport error could carry the password in some other encoding] → raw, JSON and URI forms are
  scrubbed; anything else is not known to occur.
- [No time limit on the test connection] → the prompt is over by then, so Ctrl-C ends the process;
  the file is already written and says so.
- [0600 is POSIX only] → on Windows the file inherits the user profile folder's ACL; documented.
