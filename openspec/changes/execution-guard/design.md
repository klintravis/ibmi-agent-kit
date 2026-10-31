# Design

## Context

- After `unified-kit`: one server mounts both engines; core loads profiles; every SQL/CL call goes
  through a `SqlTransport` with `query`, `execute(sql, params)` and `cl(command)`.
- Command paths today: screen `Session.typeInto` (sync) checks command-line candidates with
  `assertCommandAllowed`; `pressKey` (async) sends AID keys, and the engine itself calls it for
  sign-on, recovery and sign-off. `signOn` types `initialProgram/Menu/Library` straight into
  sign-on fields. Source `runSql` → `assertSelectOnly`; `compile` → `assertCompileCommandAllowed`,
  default target `*CURLIB`; `writeMember` issues `addpfm`/`clrpfm` internally.
- MCP SDK 1.32.2: `server.elicitInput(params, { timeout })` exists; default request timeout 60 s;
  it throws when the client did not advertise elicitation.

## Goals / Non-Goals

**Goals:** one decision function used at every entry point; deterministic, table-tested
classification; a policy a team maintains by hand; safe to install (observe by default).

**Non-Goals:** a full Db2 grammar; seeing inside programs; tamper resistance.

## Decisions

### D1. `packages/guard` is pure; the server owns I/O
`classify(text, lookups) → Operation[]`, `decide(ops, ctx, policy) → Decision`,
`loadPolicy(path)`, `redact(text)`, `RunLog`. `lookups` is an interface the server implements with
the transport (alias/view base tables via `QSYS2.SYSTABLES`/`QSYS2.SYSVIEWDEP`, current library
via `QSYS2.LIBRARY_LIST_INFO`, member text via the source engine), so the guard is tested with
plain tables and stub lookups. The server passes an async `guard(tool, input, server)` hook into
each engine's `register`.

### D2. Tokenizer plus fail-closed recognisers
A lexer (strings, `"delimited"` names, `--` and `/* */`, `;`, `CL:` lines with `+` continuation)
feeds per-statement recognisers: SELECT/VALUES/WITH, INSERT/UPDATE/DELETE/MERGE, CREATE/ALTER/DROP/
RENAME/COMMENT/LABEL/GRANT/REVOKE, CALL, SET, nested `FINAL|NEW|OLD TABLE (`, CTE bodies, `BEGIN … END`
bodies, and any `ident(.|/)ident(` or bare `ident(` that is not in a shipped list of Db2 built-in
functions → `call`. Object references after FROM/JOIN/INTO/UPDATE/TABLE/ON/CALL and DDL object
positions. Anything unrecognised → `danger`.
- *Alternative — an SQL parser library:* none covers Db2 for i system naming, `FINAL TABLE`,
  `LABEL ON` and routine bodies; a partial grammar fails silently, a lexer fails closed.

### D3. CL command table as data
`packages/guard/commands.yaml`: per command a class, the object/library parameters (keyword and
positional order), optional `writes:` parameters (`DSPOBJD OUTFILE`), optional `nested_sql:`
(`RUNSQL SQL`), optional `partition:` per parameter. Classes: `read` (DSP*/RTV* shipped entries
individually), `write` (CLRPFM, CPYF, RGZPFM, …), `ddl` (CRT*/CHG*/DLT*/MOVOBJ/RNMOBJ/CLRLIB/
DLTLIB, GRTOBJAUT/RVKOBJAUT on objects), `compile` (CRTBNDRPG, CRTRPGMOD, CRTSQLRPGI, CRTCLPGM,
CRTPGM, CRTSRVPGM, RUNSQLSTM), `call` (CALL), `liblist` (ADDLIBLE, RMVLIBLE, CHGCURLIB, CHGLIBL,
EDTLIBL), `danger` (SBMJOB, QSH, STRQSH, STRREXPRC, PWRDWNSYS, ENDSYS, ENDSBS, CHGUSRPRF,
CRTUSRPRF, DLTUSRPRF, CHGSYSVAL, ENDTCP, QCAPCMD). The policy's `commands:` merges over it.
Qualified verbs: `QSYS/` and `QSYS2/` resolve to the table entry; any other qualifier → `danger`
unless the policy lists `LIB/VERB`.

### D4. Policy shape, with the owner's model in invented names
```yaml
version: 1
mode: enforce
partitions:                      # box system name → partition
  - { name: dev,  systems: [DEVBOX] }
  - { name: qa,   systems: [QABOX] }       # mirror of prod
  - { name: prod, systems: [PRODBOX] }
unknown_partition: prod
environments:                    # per partition, first match wins
  dev:
    - { name: scratch,    libraries: [QTEMP] }
    - { name: personal,   match: ["$USER", "$USER_*"] }
    - { name: blocked,    libraries: [PAYLIB] }
    - { name: system,     match: ["Q*", "SYS*"] }
    - { name: devlibs,    match: ["DV*"] }
    - { name: integ,      match: ["IN*"] }
    - { name: stage_qa,   match: ["SQ*"] }
    - { name: stage_prod, match: ["SP*"] }
    - { name: live,       match: ["LV*"] }
  qa:
    - { name: scratch,    libraries: [QTEMP] }
    - { name: blocked,    libraries: [PAYLIB] }
    - { name: test,       match: ["QT*"] }       # before system, so QT* is not swallowed by Q*
    - { name: system,     match: ["Q*", "SYS*"] }
  prod:
    - { name: scratch,    libraries: [QTEMP] }
    - { name: system,     match: ["Q*", "SYS*"] }
roles:                           # priority order; first held group wins
  - { name: qa,      groups: [GRPQA] }
  - { name: dev,     groups: [GRPDEV] }
  - { name: analyst, groups: [GRPANL] }
default_role: analyst
commands:                        # invented change-management command
  PRMOBJ: { class: promote, objects: [OBJ], libraries: { TOLIB: { partition: qa } } }
rules:                           # first match wins; omitted key = any; unmatched = deny
  - { classes: [danger], decision: deny }
  - { env: blocked, decision: deny }
  - { env: scratch, classes: [read, write, ddl], decision: allow }
  - { roles: [dev, qa], partition: dev, env: [personal, devlibs, integ], decision: allow }
  - { roles: [qa], partition: qa, classes: [promote], decision: allow }
  - { roles: [qa], partition: qa, env: test, classes: [read, write, call], decision: allow }
  - { roles: [dev, qa], classes: [liblist], decision: allow }
  - { classes: [read], decision: allow }
```
Developers and QA have full access to personal, development and integration libraries on the dev
partition; staging and live libraries there are read-only. QA promotes into the QA partition and
writes and calls in its test libraries; everyone reads elsewhere; nothing else is allowed.
- *Why ordered rules:* they read top-down like a firewall, take exceptions without restructuring,
  and leave one precedence rule to learn.

### D5. Partition and role, once per connection
SQL connection: `SELECT CURRENT SERVER FROM SYSIBM.SYSDUMMY1` and `SELECT GROUP_PROFILE_NAME,
SUPPLEMENTAL_GROUP_LIST FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = CURRENT USER` (internal,
not decided). 5250 session: parse the sign-on screen's `System . . . :` field before signing on.
Both cached per server. Declared `IBMI_PARTITION` is compared with the detected one.

### D6. Screen hook before AID keys
`Session.pressKey(key, reporter, { guarded })`: when `guarded` (set by the tool layer, never by the
engine's own sign-on/recovery/sign-off calls) and the screen has a command line with text, await
`guard('screen_command', text, server)` before sending. `typeInto` keeps today's sync
`assertCommandAllowed` as the engine's own check. `session_open` awaits the guard for
`program`/`library` before typing sign-on fields.

### D7. Confirmation
All `confirm` operations of one tool call are gathered into one `elicitInput` with schema
`{ confirm: boolean }`, `{ timeout: 120_000 }`; accept requires `content.confirm === true`. Optional
`confirm_fallback: browser` serves a one-time token page on `127.0.0.1` from the screen engine's
existing viewer HTTP server and waits for its POST, with the not-agent-proof warning in the README.

### D8. Run log
`<first config dir>/runs/YYYY-MM-DD.jsonl`, appended synchronously; `redact()` applied to statement
text; policy hash = SHA-256 of the file bytes.

## Risks / Trade-offs

- [Tokenizer under-classifies a construct] → unrecognised heads and tails → `danger`; table tests
  cover every bypass from the design reviews.
- [Lookups add round trips] → only for changed objects and `*CURLIB`; cached per statement batch.
- [`CURRENT SERVER` is admin-set and may equal on a cloned mirror] → `IBMI_PARTITION` cross-check.
- [A reconnect after the 10-second reset drops QTEMP and the library list] → decisions are made per
  call from fresh lookups; `run_script` reports the reset and stops.
- [Confirm fatigue] → per-team rules; the run log shows frequency; observe mode first.

## Migration Plan

Additive and observe-only by default. A team writes a policy in `mode: observe`, reviews the run
log for a few weeks, then switches to `enforce`.

## Open Questions

- Whether `CURRENT SERVER` returns a usable name on PUB400; the sign-on System field is the
  fallback and the profile declaration the cross-check.
