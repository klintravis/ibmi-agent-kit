---
name: demo
description: Guided quick-start walkthrough of ibmi-agent-kit against the user's own IBM i, step by step, waiting at each human step. Use when the user says "demo", "quick start", "try the kit", or "set up my connection".
---

# demo

Walks a new user through `docs/demo.md` in the kit checkout. That file holds every command,
prompt and expected result; this skill only puts them in order. Read it once at the start and take
each step from what you read, never from memory. Compare each result with its "Expected" line.

## Where it runs

The user works in their demo folder, not the kit checkout. For this skill to be available there,
it must be copied from `<kit>/.claude/skills/demo` into the demo folder's `.claude/skills/` or into
`~/.claude/skills/` (the same copy step as docs/demo.md Part D).

## 0. Find the kit

Run `claude mcp get ibmi-agent-kit` and read its status. The kit path comes from this output, so
never ask for it and never search the disk for it.

- **Registered (Connected, or Failed to connect):** the `Args:` line is
  `<kit>/packages/server/dist/index.js`. Drop `/packages/server/dist/index.js` and the rest is
  `<kit>`. Read `<kit>/docs/demo.md`. If the server failed to connect, `setup` in section 1 names
  the cause.
- **Not found:** the server is not registered for this folder. The user registers it as in the
  kit's README (Install), with `claude mcp add` or a `.mcp.json` in this folder, then restarts
  `claude` here and approves it. Wait, then run this step again.
- **`⏸ Pending approval`:** the user restarts `claude` in this folder and approves the server.
- **`✘ Rejected (see disabledMcpjsonServers in settings)`:** the user declined the approval prompt
  once, and Claude Code saved that choice, so the server stays hidden without a word. To undo it,
  the user runs `claude mcp reset-project-choices` in a terminal in this folder, restarts `claude`
  and approves the server. If `claude mcp get ibmi-agent-kit` still shows Rejected, the user takes
  `ibmi-agent-kit` out of the disabledMcpjsonServers list in settings.local.json under this folder's
  .claude folder (Claude Code writes the rejection there), or out of any other settings file that
  lists it. Settings are the user's to edit.
- **`⊘ Disabled for this project`:** the user turns it back on in the `/mcp` panel.

Source: Claude Code docs, MCP (Server status, project scope) and Settings reference
(disabledMcpjsonServers).

## Rules

1. **Wait.** After each Human step, stop until the user says it is done. Never do one for them.
2. **Passwords.** Never ask for the password in chat. Never read, cat, grep, echo or write a profile
   file (anything under `~/.ibmi-agent-kit` or `~/.ibm-i-servers`). If the user pastes a password,
   tell them to change it now.
3. **Stop on the unexpected.** Show expected next to actual after every step. If they differ in a
   way docs/demo.md does not call Expected, show the error, name the likely cause, and stop. No retries.
4. **Confirmations are the user's.** When the guard asks a question, the user answers; never answer
   for them. `setup`, `policy replay` and `policy test` are terminal steps for the user.

## 1. Profile and password

First the demo folder's copies (docs/demo.md Setup steps 1 and 4, copy part only; they are not
profile files, so you may do this): copy `<kit>/examples/demo/` into `<demo folder>/demo/` and
`<kit>/examples/verbs/SMOKE-SAMPLE.yaml` into `<demo folder>/.ibmi-kit/verbs/`. The names in them
are set in section 3.

The profile is written by the kit's `setup` command (docs/demo.md Setup step 2), never by hand. Ask
for a profile name (`demo` if they have no preference). Then give the user this command, with
`<kit>` filled in from step 0:

```sh
node <kit>/packages/server/dist/index.js setup <name>
```

The user runs it **in their own terminal**: PowerShell, Windows Terminal, macOS Terminal or a Linux
shell. Not through you, and not with the `!` prefix. Neither is a terminal, so setup refuses, and
anything printed would land in this conversation. It asks for host, user, the password (hidden)
and a policy file. The answer to the last one is `<demo folder>/demo/policy-observe.yaml`. Wait for
the last line it prints.

- `OK: <name> signs on as <user> to <rdb>`: go on.
- `failed:` and a reason: the reason names the cause (host, user or password, SSH access, a Java
  runtime, write access to the home folder for the ssh transport, or the policy file). The user
  fixes it and runs setup again, pressing Enter to keep the answers that were right. Stop until it
  prints OK.

## 2. Connect

Call `list_servers` (their server is listed; the password is never shown) and one read-only
`run_sql`: `SELECT CURRENT USER, CURRENT SERVER FROM SYSIBM.SYSDUMMY1`. On failure, show the error
next to setup's OK line and stop.

## 3. The demo

1. Ask for a library the user owns. Upper-case it and check it is an IBM i name: 1 to 10 characters
   from A-Z 0-9 # $ @ _, the first one A-Z (a leading # or @ breaks the YAML). Refuse QGPL and any name starting with Q: it
   is written into YAML and SQL.
2. `MYUSER` is the CURRENT USER from step 2, never read from the profile.
3. Apply both in the demo folder's copies of the policies, tests and the SMOKE-SAMPLE verb
   (docs/demo.md Setup steps 1 and 4). Those copies are yours to edit, not profile files.
4. The user runs the `policy test` check from Setup step 1 in a terminal. Wait.
5. The server loads the policy once: the user restarts it (`/mcp`, restart `ibmi-agent-kit`).
6. Run Parts A, B and C of docs/demo.md one step at a time, using its prompts with the names
   filled in. Pause at each confirmation for the user. Part B starts with the user running setup
   again for the enforce policy, then a restart.
7. Part D needs a new folder and a new session. Ask for the path of a new, empty folder. Prepare it
   as Part D says: `git init`, the demo folder's `.mcp.json`, and the `<kit>/.claude/skills/ibmi-kit-config`
   copy. Then tell the user to open a terminal, `cd` into that folder and start `claude` there.
   The VS Code panel always starts in the workspace root, so the bootstrap would run in the wrong
   folder. Hand off with Part D's prompt and wait for the user's report.

## 4. Clean up and summary

Run docs/demo.md "Clean up". Summarize in a few lines: what passed, what differed from Expected.
