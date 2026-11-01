---
name: demo
description: Guided quick-start walkthrough of ibmi-agent-kit against the user's own IBM i, step by step, waiting at each human step. Use when the user says "demo", "quick start", "try the kit", or "set up my connection".
---

# demo

Walks a new user through `docs/demo.md` in the kit checkout. That file holds every command,
prompt and expected result; this skill only sequences them. Never copy them from memory: Read
the section each time, show it, and compare the result with its "Expected" line.

## Where it runs

The user works in their demo folder, not the kit checkout. To make this skill available there, copy
`<kit>/.claude/skills/demo` into the demo folder's `.claude/skills/` or into `~/.claude/skills/`
(the same copy step as docs/demo.md Part D). Start by asking for the kit checkout's absolute path,
then Read `<kit>/docs/demo.md`.

## Rules

1. **Wait.** After each Human step, stop until the user says it is done. Never do one for them.
2. **Passwords.** Never ask for the password in chat. Never read, cat, grep, echo or write a profile
   file (anything under `~/.ibmi-agent-kit` or `~/.ibm-i-servers`). If the user pastes a password,
   tell them to change it now.
3. **Stop on the unexpected.** Show expected next to actual after every step. If they differ in a
   way docs/demo.md does not call Expected, show the error, name the likely cause, and stop. No retries.
4. **Confirmations are the user's.** When the guard asks a question, the user answers; never answer
   for them. `policy replay` and `policy test` are terminal steps for the user.

## 1. Profile and password

First the demo folder's copies (docs/demo.md Setup steps 1 and 4, copy part only; they are not
profile files, so you may do this): copy `<kit>/examples/demo/` into `<demo folder>/demo/` and
`<kit>/examples/verbs/SMOKE-SAMPLE.yaml` into `<demo folder>/.ibmi-kit/verbs/`. The names in them
are set in section 3.

Explain: profiles live in `~/.ibmi-agent-kit/.env.<name>` (README, Profiles). The user creates that
file from `packages/source/.env.example` and types `IBMI_HOST`, `IBMI_USER` and `IBMI_PASSWORD`
in their own editor. They also add the `IBMI_KIT_POLICY=` line that points at the demo observe
policy copy (docs/demo.md Setup step 2). Wait for "done".

## 2. Connect

The user confirms the kit server is registered in the demo folder: `.mcp.json` or `claude mcp add`
(docs/demo.md Setup steps 3 and 5). Then call `list_servers` (their server is listed; the password
is never shown) and one read-only `run_sql`: `SELECT CURRENT USER, CURRENT SERVER FROM SYSIBM.SYSDUMMY1`.

On failure, show the error and point to the likely cause: host, or user and password in the
profile; for the ssh transport also SSH access, a Java runtime, and write access to the home
folder (README, SQL transports). If the server did not start or the error names the policy: the
`IBMI_KIT_POLICY` path is missing, not absolute, or not a valid policy. Stop.

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
   filled in. Pause at each confirmation for the user. Part B starts with a Human policy switch
   and restart.
7. Part D runs in a new folder and session: hand off with its instructions and wait for the
   user's report.

## 4. Clean up and summary

Run docs/demo.md "Clean up". Summarize in a few lines: what passed, what differed from Expected.
