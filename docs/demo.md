# Quick start demo

A 5-minute demo of the guard (observe, then enforce), verbs and the config bootstrap, run against
your own IBM i: PUB400 or your own box. Every step names its expected result. Steps marked
**Human** need you; the rest you paste to Claude.

## Prerequisites

- Node 20 or newer, and the kit built as in the [README install](../README.md#install).
- A profile with the password set: see [Profiles](../README.md#profiles) (`~/.ibmi-agent-kit/.env.<name>`
  with `IBMI_HOST`, `IBMI_USER`, `IBMI_PASSWORD`; on PUB400 see [PUB400](../README.md#pub400)).
  Below the profile is called `demo`; use your own name.
- A library you own, called `MYLIB` here. Never `QGPL`.
- One connection at a time, and no retry loops: if a call fails, stop and read the error.

## Setup (5 minutes, Human)

1. Add a line to the profile file, with the absolute path to your checkout:

   ```ini
   IBMI_KIT_POLICY=<abs path>/examples/demo/policy-observe.yaml
   ```

2. In both demo policies and both tests files under [`examples/demo`](../examples/demo), replace
   `MYLIB` with your library and `MYUSER` with your IBM i user (upper case). Check with
   `node <abs path>/packages/server/dist/index.js policy test examples/demo/policy-observe.yaml examples/demo/observe.tests.yaml`
   (prints `N cases passed`).
3. Make an empty demo folder with a `.mcp.json` registering the kit server (the same command as
   the README's `claude mcp add`):

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
connection; if a call fails, stop and report, do not retry.
1. list_servers.
2. policy_check for each, and show decision, class, env, roles and roleSource:
   SELECT * FROM MYLIB.T; CREATE TABLE MYLIB.T (X INT); CL: DLTF FILE(X); CL: PWRDWNSYS
   Expected: allow, allow, deny, deny (in observe, denies are logged, not blocked).
3. run_script: CREATE TABLE MYLIB.DEMOT (X INT); INSERT INTO MYLIB.DEMOT VALUES (1), (2);
   SELECT * FROM MYLIB.DEMOT; DROP TABLE MYLIB.DEMOT. Expected: all four run; the SELECT returns 2 rows.
4. run_sql, read-only, the queries the guard itself uses; show the raw values:
   - SELECT SUPPLEMENTAL_GROUP_LIST, GROUP_PROFILE_NAME FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = CURRENT USER
   - SELECT COUNT(*) FROM QSYS2.AUTHORIZATION_LIST_USER_INFO
   - SELECT COUNT(*) FROM QSYS2.SYSVIEWDEP; SELECT TABLE_NAME, TABLE_TYPE FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'MYLIB'
   - SELECT * FROM QSYS2.LIBRARY_LIST_INFO
   Expected: rows come back. If your system refuses one, say which (the guard then treats a write
   through a view or alias as deny).
```

**Human**, in a terminal: `node <abs path>/packages/server/dist/index.js policy replay <abs path>/examples/demo/policy-observe.yaml --since 1`.
Expected: the last line reads `0 of N statements change under ...`, since the log was written
under the same policy (see [docs/policy.md](policy.md)).

## B. Enforce

**Human**: change the profile line to `.../examples/demo/policy-enforce.yaml`, then run `/mcp` and
restart `ibmi-agent-kit`. Paste:

```text
Use the ibmi-agent-kit tools on server demo; same rules as before (MYLIB only, no retries).
1. policy_check the four statements from A.2. Expected: allow, confirm, deny, deny.
2. run_script CREATE TABLE MYLIB.DEMOT (X INT); INSERT INTO MYLIB.DEMOT VALUES (1);
   SELECT * FROM MYLIB.DEMOT; DROP TABLE MYLIB.DEMOT. The CREATE and the DROP ask first. Expected:
   I answer yes; the INSERT and SELECT run without asking.
3. run_script CREATE TABLE MYLIB.DEMOT2 (X INT). I answer no. Expected: nothing is sent. Prove it:
   SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'MYLIB' AND TABLE_NAME = 'DEMOT2'
   returns no row.
4. run_script CL: DLTF FILE(X). Expected: refused (deny), nothing sent.
```

**Human**: answer the confirmation questions: yes for step 2 (both), no for step 3.

## C. Verbs

Works with either policy:

```text
Use the ibmi-agent-kit tools on server demo (MYLIB only, no retries).
1. verb_list. Expected: SMOKE-SAMPLE, tag smoke, from the project layer.
2. policy_check with verb SMOKE-SAMPLE. Expected: allow (observe) or confirm on its DDL (enforce).
3. verb_run with tag smoke, twice. Expected: both pass (setup, NOTE=hello, cleanup drops the table).
4. run_sql CREATE TABLE MYLIB.SMOKESAMPLE (ID INTEGER, NOTE VARCHAR(20)), then verb_run tag smoke.
   Expected: it fails at requires_absent and does NOT drop the table. Then DROP TABLE MYLIB.SMOKESAMPLE
   by hand (run_sql).
```

In enforce mode the DDL asks first: **Human** answers.

## D. Config bootstrap

**Human**: make an empty folder, `git init` it, open Claude Code there and ask:

```text
Use the ibmi-kit-config skill to bootstrap this repo for server demo (read-only discovery; no
password anywhere in the files).
```

Expected: the files in [`templates/company-repo/README.md`](../templates/company-repo/README.md), a
policy in observe mode on a branch. **Human**, in a terminal in that folder:
`node <abs path>/packages/server/dist/index.js policy test policy.yaml policy.tests.yaml` prints
`N cases passed`.

## Clean up

```text
run_sql SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'MYLIB'
```

Expected: none of `T`, `DEMOT`, `DEMOT2`, `SMOKESAMPLE` from this demo. Remove the profile's
`IBMI_KIT_POLICY` line if you do not want the policy to stay on.
