# Design

## Context

- Command paths today: screen `session.ts` checks text typed into command-line candidates with
  `assertCommandAllowed` (restricted allowlist, then `blockedCl`); source `runSql` calls
  `assertSelectOnly` (regex scan for select/with, writes, `qcmdexc(`, comments, inner `;`);
  `compile` calls `assertCompileCommandAllowed` (crt*/runsqlstm only, destructive verbs refused);
  `writeMember` issues `addpfm`/`clrpfm` via `qcmdexc` itself.
- Engines issue internal statements (QTEMP aliases, `ovrprtf`, `dltsplf`, `addpfm`, `clrpfm`)
  that are not user text. The guard decides at tool entry points, never on these.
- After `unified-kit`, the server mounts both engines and owns their lifecycle.
- MCP SDK 1.32.2 is installed; `server.elicitInput` exists and throws when the client did not
  advertise elicitation.

## Goals / Non-Goals

**Goals:** one decision function used by every guarded entry point; deterministic,
table-testable classification; a policy format a team can maintain by hand.

**Non-Goals:** a full Db2 SQL grammar; seeing inside programs; tamper resistance.

## Decisions

### D1. New `packages/guard`, pure and IBM-i-free
`classify(text, ctx) → Operation[]`, `decide(ops, ctx, policy) → Decision`, `loadPolicy(path)`,
`RunLog`. `ctx` = user, role, partition, library list snapshot. No network code, so the whole
package is tested with plain tables. The server builds `ctx` per call and passes a
`guard(tool, text|ops, server)` hook into each engine's `register` (added to the hooks from
`unified-kit`).

### D2. Tokenizer, not a grammar
A hand-written lexer (strings, `"delimited"` identifiers, `--` and `/* */` comments, `;`) feeds a
small recogniser per statement head: SELECT/VALUES/WITH, INSERT/UPDATE/DELETE/MERGE, CREATE/ALTER/
DROP/RENAME/COMMENT/LABEL/GRANT/REVOKE, CALL, SET, plus nested `FINAL|NEW|OLD TABLE (`, CTE bodies,
`BEGIN … END` routine bodies, and `QCMDEXC(` arguments. Object references are `ident(.|/)ident`
after FROM/JOIN/INTO/UPDATE/TABLE/ON/CALL and the DDL object position. Anything unrecognised →
`danger`.
- *Alternative — an SQL parser library:* none on npm covers Db2 for i system naming, `FINAL
  TABLE`, `LABEL ON` and routine bodies; a partial grammar fails in surprising ways. A lexer plus
  fail-closed recognisers fails safe.

### D3. CL command table as data
`commands.yaml` in the guard package: `CRTPF: { class: ddl, objects: [FILE] }`,
`DSPOBJD: { class: read, objects: [OBJ], writes: [OUTFILE] }`, `CALL: { class: call, objects: [PGM] }`,
`SBMJOB: { class: danger, nested: CMD }`, `RUNSQL: { nested_sql: SQL }`, etc. Positional parameters
are mapped from the command's documented order for the commands shipped. A policy's `commands:`
section adds or overrides entries (e.g. a change-management vendor's promote command).

### D4. Policy shape: partitions, environments, roles, ordered rules
```yaml
version: 1
partitions:                      # box system name → partition
  - { name: dev,  systems: [DEVBOX] }
  - { name: qa,   systems: [QABOX] }       # mirrors prod's libraries
  - { name: prod, systems: [PRODBOX] }
unknown_partition: prod
environments:                    # per partition, first match wins
  dev:
    - { name: scratch,  libraries: [QTEMP] }
    - { name: personal, match: ["$USER", "$USER_*"] }
    - { name: system,   match: ["Q*", "SYS*"] }
    - { name: blocked,  libraries: [PAYLIB] }
    - { name: devlibs,  match: ["DV*"] }
    - { name: integ,    match: ["IN*"] }
  qa:
    - { name: scratch,  libraries: [QTEMP] }
    - { name: system,   match: ["Q*", "SYS*"] }
    - { name: blocked,  libraries: [PAYLIB] }
    - { name: test,     match: ["QT*"] }
  prod:
    - { name: scratch,  libraries: [QTEMP] }
    - { name: system,   match: ["Q*", "SYS*"] }
roles:                           # priority order; first held group wins
  - { name: qa,      groups: [GRPQA] }
  - { name: dev,     groups: [GRPDEV] }
  - { name: analyst, groups: [GRPANL] }
default_role: analyst
commands:
  PRMOBJ: { class: promote, objects: [OBJ], libraries: [TOLIB] }   # invented vendor command
rules:                           # first match wins; unmatched → deny
  - { env: blocked, decision: deny }
  - { env: scratch, classes: [read, write, ddl], decision: allow }   # QTEMP belongs to the job
  - { roles: [dev, qa], partition: dev, env: [personal, devlibs], classes: "*", decision: allow }
  - { roles: [dev, qa], partition: dev, env: integ, classes: [write, ddl, compile], decision: confirm }
  - { roles: [qa], partition: dev, classes: [promote], decision: allow }
  - { roles: [qa], partition: qa, env: test, classes: [read, write, call], decision: allow }
  - { classes: [danger], decision: deny }
  - { classes: [read], decision: allow }
```
This expresses the owner's stated model with invented names: QA has developer access on the dev
partition and runs promotions there; on the QA partition (a mirror of prod) QA reads everywhere
and writes and calls in test libraries; developers read the QA and prod partitions only.
- *Why ordered rules, not a role × env × class matrix:* rules read top-down like a firewall, add
  exceptions without restructuring, and make "first match" the only precedence to learn.

### D5. Partition and role are read from the box, once per connection
On first SQL use per server: `SELECT CURRENT SERVER FROM SYSIBM.SYSDUMMY1` and
`SELECT GROUP_PROFILE_NAME, SUPPLEMENTAL_GROUP_LIST FROM QSYS2.USER_INFO WHERE
AUTHORIZATION_NAME = CURRENT USER`. These are engine-internal reads and not themselves guarded.
For a 5250-only session, the partition comes from the sign-on screen's System field and the role
falls back to `default_role` until an SQL connection exists.

### D6. Confirmation through elicitation, one statement at a time
`confirm` calls `server.elicitInput` with a boolean schema and a message holding server,
partition, statement and operations. Missing capability, decline, cancel or a 120-second timeout
→ deny. The decision is not cached: each confirmed statement is asked for.

### D7. Run log as JSONL
`<first config dir>/runs/YYYY-MM-DD.jsonl`, appended synchronously per statement. Policy hash is
SHA-256 of the file bytes read at startup.

## Risks / Trade-offs

- [Tokenizer misses a construct and under-classifies] → unknown statement heads and unparsed
  tails classify as `danger`; table tests cover every bypass from the design reviews.
- [Confirm fatigue in integration libraries] → rules make it a per-team choice; the run log shows how often it fires.
- [Positional CL parameters] → only shipped commands get positional maps; others must use
  keyword form or classify as `danger` when a library parameter is missing.
- [Group lookup latency on every call] → cached per connection.
- [Elicitation support in the company's client is unknown] → without it, `confirm` behaves as
  `deny`, so the policy is still safe, only stricter.

## Migration Plan

Additive. Without `IBMI_KIT_POLICY`, the built-in default applies, which allows everything the
engines allowed for reads and asks for confirmation on writes.

## Open Questions

- Whether `CURRENT SERVER` returns a usable name on PUB400; check once an account exists (the
  sign-on screen system name is the fallback).
