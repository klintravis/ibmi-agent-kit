# Quick start demo

A 5-minute demo of the guard (observe, then enforce), verbs and the config bootstrap, run against
your own IBM i: PUB400 or your own box. Every step names its expected result. Steps marked
**Human** need you; the rest you paste to Claude. For a guided version, copy the kit's
`.claude/skills/demo` into your demo folder's `.claude/skills/` (or `~/.claude/skills/`) and run `/demo`.

## Prerequisites

- Node 20 or newer, and the kit built as in the [README install](../README.md#install).
- A profile with the password set: see [Profiles](../README.md#profiles) (`~/.ibmi-agent-kit/.env.<name>`
  with `IBMI_HOST`, `IBMI_USER`, `IBMI_PASSWORD`; on PUB400 see [PUB400](../README.md#pub400)).
  Below the profile is called `demo`; use your own name.
- A library you own, called `MYLIB` here. Never `QGPL`.
- One connection at a time, and no retry loops: if a call fails unexpectedly, stop and read the error.

## Setup (5 minutes, Human)

1. Make an empty demo folder and copy `examples/demo/` from the kit into it. Edit the copies, not
   the kit checkout: in the two policies and two tests files replace `MYLIB` with your library and
   `MYUSER` with your IBM i user (upper case). Check with
   `node <abs path>/packages/server/dist/index.js policy test <demo folder>/demo/policy-observe.yaml <demo folder>/demo/observe.tests.yaml`
   (prints `5 cases passed`).
2. Add a line to the profile file, with the absolute path to the copy:

   ```ini
   IBMI_KIT_POLICY=<demo folder>/demo/policy-observe.yaml
   ```

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

4. Copy [`examples/verbs/SMOKE-SAMPLE.yaml`](../examples/verbs/SMOKE-SAMPLE.yaml) to
   `.ibmi-kit/verbs/` in the demo folder and set the library: in its `params.lib`, change
   `default: MYLIB` and `allowed: [MYLIB]` to your library (see [docs/verbs.md](verbs.md)).
5. Open Claude Code in the demo folder and approve the `ibmi-agent-kit` server.

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

**Human**: change the profile line to `.../demo/policy-enforce.yaml`, then run `/mcp` and
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
`~/.claude/skills/`): the skill lives in the kit checkout, not in your folder. Open Claude Code
there and ask:

```text
Use the ibmi-kit-config skill to bootstrap this repo for server demo (read-only discovery; no
password anywhere in the files).
```

The skill asks its questions one at a time: **Human** answers. Discovery reads system-wide catalogs,
so on a shared box (PUB400) it may come back partial. Expected: the files in
[`templates/company-repo/README.md`](../templates/company-repo/README.md), a policy in observe mode,
and a commit on a `kit-config/bootstrap-<date>` branch. **Human**, in a terminal in that folder:
`node <abs path>/packages/server/dist/index.js policy test policy.yaml policy.tests.yaml` prints
`N cases passed`.

## Clean up

```text
run_sql SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'MYLIB'
```

Expected: none of `T`, `DEMOT`, `DEMOT2`, `SMOKESAMPLE` from this demo. **Human**: delete the demo
folder copies (they hold your library and user names) and the `IBMI_KIT_POLICY` line if you do not
want the policy to stay on.
