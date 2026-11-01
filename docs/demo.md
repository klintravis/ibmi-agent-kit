# Quick start demo

A 5-minute demo of the guard (observe, then enforce), verbs and the config bootstrap, run against
your own IBM i: PUB400 or your own box. Every step names its expected result. Steps marked
**Human** need you; the rest you paste to Claude. For a guided version, copy the kit's
`.claude/skills/demo` into your demo folder's `.claude/skills/` (or `~/.claude/skills/`) and run `/demo`.

## Prerequisites

- Node 20 or newer, and the kit built as in the [README install](../README.md#install).
- Your IBM i host, user and password. Setup step 2 turns them into a profile (on PUB400 see
  [PUB400](../README.md#pub400)). Below the profile is called `demo`; use your own name.
- A library you own, called `MYLIB` here. Never `QGPL`.
- One connection at a time, and no retry loops: if a call fails unexpectedly, stop and read the error.

## Setup (5 minutes, Human)

1. Make an empty demo folder and copy `examples/demo/` from the kit into it. Edit the copies, not
   the kit checkout: in the two policies and two tests files replace `MYLIB` with your library and
   `MYUSER` with your IBM i user (upper case). Check with
   `node <abs path>/packages/server/dist/index.js policy test <demo folder>/demo/policy-observe.yaml <demo folder>/demo/observe.tests.yaml`
   (prints `5 cases passed`).
2. Create the profile. In your own terminal (PowerShell, Windows Terminal, macOS Terminal or a
   Linux shell; not through Claude and not with Claude's `!` prefix), run
   `node <abs path>/packages/server/dist/index.js setup demo`. It asks for the host, the user, the
   password (hidden) and a policy file. Answer the policy prompt with
   `<demo folder>/demo/policy-observe.yaml`. Expected: the last line reads
   `OK: demo signs on as <user> to <rdb>`. On `failed:`, fix what it names and run it again;
   Enter keeps an answer. See [`setup` command](../packages/server/README.md#setup-command).
3. In the demo folder, a `.mcp.json` registering the kit server (the same command as the README's
   `claude mcp add`):

   ```json
   {
     "mcpServers": {
       "ibmi-agent-kit": {
         "command": "node",
         "args": ["<abs path>/packages/server/dist/index.js"]
       }
     }
   }
   ```

   To watch 5250 sessions live in your browser, add `"env": { "IBMI_5250_VIEWER": "true" }` next to
   `"args"` (or `claude mcp add -e IBMI_5250_VIEWER=true --transport stdio ibmi-agent-kit -- node <abs path>/packages/server/dist/index.js`).
   Settings that are not protected, like this one, may go in the registration's env. Protected
   settings come only from the profile file: host, user, password, policy and every `IBMI_*_PORT`,
   `IBMI_5250_VIEWER_PORT` included. The full list is in [Profiles](../README.md#profiles). If
   the profile file sets the same key, the file wins. See the
   [screen README](../packages/screen/README.md) for the viewer.

4. Copy [`examples/verbs/SMOKE-SAMPLE.yaml`](../examples/verbs/SMOKE-SAMPLE.yaml) to
   `.ibmi-kit/verbs/` in the demo folder and set the library: in its `params.lib`, change
   `default: MYLIB` and `allowed: [MYLIB]` to your library (see [docs/verbs.md](verbs.md)).
5. In a terminal, `cd` into the demo folder and start `claude`, then approve the `ibmi-agent-kit`
   server. If you declined it, Claude Code remembers that and hides the server without telling you:
   `claude mcp get ibmi-agent-kit` then shows `✘ Rejected`. To be asked again, run
   `claude mcp reset-project-choices` in that folder and restart `claude`. If it still shows
   Rejected, remove `ibmi-agent-kit` from `disabledMcpjsonServers` in `.claude/settings.local.json`
   there. See Claude Code's MCP docs, Server status.

## A. Guard in observe mode

Paste, with `demo` and `MYLIB` replaced:

```text
Use the ibmi-agent-kit tools on server demo. Only library MYLIB (and QTEMP); never QGPL; one
connection; no retries. A refusal or failure marked Expected is a result, not a failure: report it
and go on. Stop only on an unexpected error.
1. list_servers. Expected: the server listed, no open sessions.
2. policy_check for each, and show decision, class, env and roles:
   SELECT * FROM MYLIB.T; CREATE TABLE MYLIB.T (X INT); CL: DLTF FILE(X); CL: PWRDWNSYS
   Expected: allow, allow, deny, deny. The unqualified change and the danger command are denied in
   every mode, observe included; other denies in observe are only logged.
3. run_script: CREATE TABLE MYLIB.DEMOT (X INT); INSERT INTO MYLIB.DEMOT VALUES (1), (2);
   SELECT * FROM MYLIB.DEMOT; DROP TABLE MYLIB.DEMOT. Expected: all four run; the SELECT returns 2 rows.
4. run_sql, one statement per call, read-only: the guard's own lookups, with their column lists,
   for the current user and your library:
   - SELECT CURRENT SERVER AS RDB, CURRENT USER AS USR FROM SYSIBM.SYSDUMMY1
   - SELECT GROUP_PROFILE_NAME AS G, SUPPLEMENTAL_GROUP_LIST AS S FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = CURRENT USER
   - SELECT AUTHORIZATION_LIST AS A FROM QSYS2.AUTHORIZATION_LIST_USER_INFO WHERE AUTHORIZATION_NAME = CURRENT USER
   - SELECT BASE_TABLE_SCHEMA AS L, BASE_TABLE_NAME AS N FROM QSYS2.SYSTABLES WHERE TABLE_TYPE = 'A' AND SYSTEM_TABLE_SCHEMA = 'MYLIB'
   - SELECT OBJECT_SCHEMA AS L, OBJECT_NAME AS N FROM QSYS2.SYSVIEWDEP WHERE SYSTEM_VIEW_SCHEMA = 'MYLIB'
   - SELECT SYSTEM_SCHEMA_NAME AS S FROM QSYS2.SYSSCHEMAS WHERE SCHEMA_NAME = 'MYLIB'
   - SELECT SYSTEM_SCHEMA_NAME AS S FROM QSYS2.LIBRARY_LIST_INFO WHERE TYPE = 'CURRENT'
   Expected: each returns (possibly zero) rows. If one is refused, say which. What it means:
   SYSDUMMY1 refused: the profile's user decides with default_role. USER_INFO or
   AUTHORIZATION_LIST_USER_INFO refused: roles from groups and authorization lists are dropped;
   roles by user name still match, otherwise default_role. SYSTABLES or SYSVIEWDEP refused: the
   guard denies writes through a view or alias. SYSSCHEMAS refused: a long SQL schema name is not
   mapped to its system name. LIBRARY_LIST_INFO refused: changes to `*CURLIB` objects are refused as unqualified.
```

**Human**, in a terminal: `node <abs path>/packages/server/dist/index.js policy replay <demo folder>/demo/policy-observe.yaml --since 1`.
Expected: the last line reads `0 of N statements change under ...`, since the log was written
under the same policy (see [docs/policy.md](policy.md)).

## B. Enforce

**Human**: run `setup demo` again in your terminal. Press Enter for host, user and password, and
answer the policy prompt with `<demo folder>/demo/policy-enforce.yaml`. Then run `/mcp` and
restart `ibmi-agent-kit`. Paste:

```text
Use the ibmi-agent-kit tools on server demo; same rules as before (MYLIB only, no retries). A
refusal or failure marked Expected is a result, not a failure: report it and go on. Stop only on an
unexpected error.
1. policy_check the four statements from A.2. Expected: allow, confirm, deny, deny.
2. run_script CREATE TABLE MYLIB.DEMOT (X INT); INSERT INTO MYLIB.DEMOT VALUES (1);
   SELECT * FROM MYLIB.DEMOT; DROP TABLE MYLIB.DEMOT. Expected: one question naming the CREATE and
   the DROP; I answer yes; then all four run.
3. run_script CREATE TABLE MYLIB.DEMOT2 (X INT). I answer no. Expected: nothing is sent (an error
   result). Prove it: SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'MYLIB' AND
   TABLE_NAME = 'DEMOT2' returns no row.
4. run_script CL: DLTF FILE(X). Expected: refused (deny), nothing sent.
```

**Human**: answer the confirmation questions: yes to the one in step 2, no to the one in step 3.

## C. Verbs

Works with either policy:

```text
Use the ibmi-agent-kit tools on server demo (MYLIB only, no retries). A refusal or failure marked
Expected is a result, not a failure: report it and go on. Stop only on an unexpected error.
1. verb_list. Expected: SMOKE-SAMPLE, tag smoke, from the project layer.
2. policy_check with verb SMOKE-SAMPLE. Expected: allow (observe) or confirm on its DDL (enforce).
3. verb_run with tag smoke, twice. Expected: both pass (setup, NOTE=hello, cleanup drops the table).
4. run_script CREATE TABLE MYLIB.SMOKESAMPLE (ID INTEGER, NOTE VARCHAR(20)); then verb_run tag smoke.
   Expected: verb_run fails at requires_absent (an error result) and does NOT drop the table. Then
   run_script DROP TABLE MYLIB.SMOKESAMPLE by hand.
```

In enforce mode each `verb_run` and each `run_script` with DDL asks one question for all its
statements needing confirmation: **Human** answers yes.

## D. Config bootstrap

**Human**: make an empty folder and `git init` it. Copy the demo folder's `.mcp.json` into it, and
copy `<abs path>/.claude/skills/ibmi-kit-config` into its `.claude/skills/` (or into
`~/.claude/skills/`): the skill lives in the kit checkout, not in your folder. In a terminal, `cd`
into that folder and start `claude` there. Don't use the VS Code panel: it starts in the workspace
root, so the bootstrap would run in the wrong folder. Approve the server, then ask:

```text
Use the ibmi-kit-config skill to bootstrap this repo for server demo (read-only discovery; no
password anywhere in the files).
```

The skill asks its questions one at a time: **Human** answers. Discovery reads system-wide catalogs,
so on a shared box (PUB400) it may come back partial. Expected: the files in
[`templates/company-repo/README.md`](../templates/company-repo/README.md), a policy in observe mode,
and a commit on a `kit-config/bootstrap-<date>` branch. The bootstrap replaces the copied
`.mcp.json` with a portable one that starts the kit from `${IBMI_KIT_HOME}`, so this session keeps
its server, and a later session in that folder needs `IBMI_KIT_HOME` set (the repo's README, Get
started). **Human**, in a terminal in that folder:
`node <abs path>/packages/server/dist/index.js policy test policy.yaml policy.tests.yaml` prints
`N cases passed`.

## Clean up

```text
run_sql SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'MYLIB'
```

Expected: none of `T`, `DEMOT`, `DEMOT2`, `SMOKESAMPLE` from this demo. **Human**: delete the demo
folder copies (they hold your library and user names). If you don't want the policy to stay on,
delete the `IBMI_KIT_POLICY` line from the profile file, which is `~/.ibmi-agent-kit/.env.demo`
unless `IBMI_KIT_CONFIG_DIR` is set (`setup` prints the path).

## E. Build and watch (about 10 minutes)

Builds a small RPG app in your library, runs its unit tests, then drives its subfile screen while
you watch in the browser. The app is a seed-stock list: a physical file of 8 seeds, a display file,
a service program with the status rule, the list program and a unit-test program. Part E needs
only Setup and part A, so you can run it right after A, before B, C and D. It works under either
demo policy and has its own clean-up (step 11): the Clean up section above is not needed for it.

Everything part E sends to the box is in the kit's files: four verbs in
[`examples/demo/verbs/`](../examples/demo/verbs/) (SEED-PREP, SEED-BUILD, SEED-ADDROW, SEED-CLEAN),
six source members in [`examples/showcase/src/`](../examples/showcase/src/) and two screen tests in
[`examples/showcase/screen-tests/`](../examples/showcase/screen-tests/). It makes objects only in
your library, and only these: `SEEDSRC`, `SEEDS`, `SEEDDSPF`, `SEEDSRV`, `SEEDLST`, `SEEDTST`.
SEED-CLEAN deletes exactly those and fails if any is left.

**Human**, before the prompt:

1. Viewer: if you left it out in Setup step 3, add `"env": { "IBMI_5250_VIEWER": "true" }` next
   to `"args"` in the demo folder's `.mcp.json`. Never in the profile file. Expected: nothing yet;
   the `Live view:` line in step 6 shows it took.
2. Library: Setup step 1 copied the verbs along with the policies. In
   `<demo folder>/demo/verbs/SEED-*.yaml` replace `MYLIB` with your library, and in
   `<demo folder>/demo/showcase-observe.tests.yaml` and `showcase-enforce.tests.yaml` replace
   `MYLIB` and `MYUSER` as in Setup step 1. Optional check:
   `node <abs path>/packages/server/dist/index.js policy test <demo folder>/demo/policy-observe.yaml <demo folder>/demo/showcase-observe.tests.yaml`
   prints `5 cases passed` (the enforce pair too). Then restart the server once: `/mcp`, restart
   `ibmi-agent-kit`. The server reads its verbs once and caches them, and reads the viewer setting
   at start, so both edits need this one restart. Expected: the server is connected again.

Paste, with `demo`, `MYLIB` and `<kit>` (the kit checkout's absolute path) replaced:

```text
Use the ibmi-agent-kit tools on server demo (MYLIB only, never QGPL, one connection, no retries).
A refusal or failure marked Expected is a result, not a failure: report it and go on. Stop only on
an unexpected error.
3. verb_run SEED-PREP. Expected: passes; the check finds no SEED object in MYLIB, then CRTSRCPF
   makes MYLIB/SEEDSRC. If the check fails, an earlier run left objects behind: run step 11, then
   this step again.
4. upload_source_member six times, one per file in <kit>/examples/showcase/src/ (SEEDS.pf,
   SEEDDSPF.dspf, SEEDPR.rpgle, SEEDSRV.rpgle, SEEDLST.rpgle, SEEDTST.rpgle): library MYLIB,
   sourceFile SEEDSRC, member = the file name without its extension, localPath = the file,
   create: true. Expected: six members, typed PF, DSPF and RPGLE from the extensions.
5. verb_run SEED-BUILD. Expected: passes. CHGCURLIB makes MYLIB the current library, CRTPF and
   the 8 rows, the display file, three modules, the service program SEEDSRV, the programs SEEDLST
   and SEEDTST, and last CALL PGM(MYLIB/SEEDTST), the unit-test line: SEEDTST: 9 passed, 0 failed.
   A failed assertion fails that step with "Failed:" and the names. A compile failure names the
   member: compile_member on that member shows the compiler's messages. CHGCURLIB leaves the SQL
   job's current library set for the rest of the server's life; it changes no guard decision,
   since unqualified names are denied anyway.
6. session_open with program MYLIB/SEEDLST and library MYLIB. Expected: a line
   "Live view: <url>  <- open this to watch" and the Seed Stock List screen. Show me the URL.
7. screen_snapshot, then screen_do one step at a time. Expected: the list shows 8 rows, Sunflower
   to Kale, with a Status column, Bottom, and 8 seeds. at the foot. Option 5 on Tomato (type 9,3: 5
   and Enter) shows Seed Detail with In stock; F12 returns to the list. Option 5 on Basil (8,3) and
   Kale (14,3) in one Enter shows Basil's detail (Low), Enter shows Kale's (Overstock), Enter
   returns to the list.
8. run_tests with path <kit>/examples/showcase/screen-tests and session default. Expected:
   all 2 test(s) passed.
9. verb_run SEED-ADDROW, then screen_do key F5. Expected: Marigold appears as row 9 (In stock)
   and the foot reads 9 seeds.
10. screen_do key F3, then session_close. Expected: F3 ends SEEDLST, the job's sign-on program, so
   the job ends and the sign-on screen comes back; session_close reports Session "default" closed.
   Signed off cleanly. If it says no sign off was possible instead, the job already ended with
   the program: go on.
11. verb_run SEED-CLEAN. Expected: passes, ending on the empty check: no SEED object is left in
   MYLIB. If SEED-BUILD stopped halfway, SEED-CLEAN stops at the first missing object: run_sql the
   check query from SEED-PREP.yaml to list the names left, delete those with the matching lines of
   SEED-CLEAN.yaml through run_script, then run_sql the check again (no rows).
```

**Human**: open the `Live view:` URL in your browser at step 6 and watch steps 7 to 10. In enforce
mode steps 3, 5 and 11 each ask one question (CRTSRCPF; CRTPF; all nine deletes at once): answer
yes. Under observe nothing asks.

The SEED verbs stay in the demo folder's `demo/verbs/` (the org layer, beside the policy), so part
C's `verb_list` shows them next to SMOKE-SAMPLE.
