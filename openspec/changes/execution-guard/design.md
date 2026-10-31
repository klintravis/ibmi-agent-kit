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
- The kit must fit shops beyond the owner's: one-partition ladders, two or three LPARs, IASPs,
  per-developer and per-ticket libraries, and change-management products that promote by request
  and level rather than by target library.

## Goals / Non-Goals

**Goals:** one decision function at every entry point; deterministic, table-tested
classification; a policy a team writes by hand from a template and tests in its own CI; safe to
install (observe by default).

**Non-Goals:** a full Db2 grammar; seeing inside programs; tamper resistance; regex patterns,
pattern captures, general includes or variables in the policy; break-glass or separation-of-duty
features (the IBM i and the change-management product own those).

## Decisions

### D1. `packages/guard` is pure; the server owns I/O
`classify(text, lookups) → Operation[]`, `decide(ops, identity, policy) → Decision`,
`loadPolicy(path)`, `redact(text)`, `RunLog`. `lookups` is an interface: the server implements it
with the transport (alias/view base tables via `QSYS2.SYSTABLES`/`QSYS2.SYSVIEWDEP`, long → system
schema names via `QSYS2.SYSSCHEMAS`, current library via `QSYS2.LIBRARY_LIST_INFO`, member text via
the source engine); policy tests implement it with stated answers. The server passes an async
`guard(tool, input, server)` hook into each engine's `register`.

### D2. Tokenizer plus fail-closed recognisers
A lexer (strings, `"delimited"` names, `--` and `/* */`, `;`, `CL:` lines with `+` continuation)
feeds per-statement recognisers: SELECT/VALUES/WITH, INSERT/UPDATE/DELETE/MERGE, CREATE/ALTER/DROP/
RENAME/COMMENT/LABEL/GRANT/REVOKE, CALL, SET, CONNECT/SET CONNECTION/DISCONNECT, nested
`FINAL|NEW|OLD TABLE (`, CTE bodies, `BEGIN … END` bodies, and any `ident(.|/)ident(` or bare
`ident(` not in a shipped list of Db2 built-in functions → `call`. Object references after
FROM/JOIN/INTO/UPDATE/TABLE/ON/CALL and DDL object positions, with one-, two- and three-part names.
Anything unrecognised → `danger`.
- *Alternative — an SQL parser library:* none covers Db2 for i system naming, `FINAL TABLE`,
  `LABEL ON` and routine bodies; a partial grammar fails silently, a lexer fails closed.

### D3. CL command table as data, extensible per product
`packages/guard/commands.yaml` holds IBM commands: class, object/library parameters (keyword and
positional order), optional `writes:` (`DSPOBJD OUTFILE`), `nested_sql:` (`RUNSQL SQL`), and
per-parameter `partition:`. Built-in classes: `read`, `write`, `ddl`, `compile`, `call`, `liblist`,
`promote`, `danger` (SBMJOB, QSH, STRQSH, STRREXPRC, PWRDWNSYS, ENDSYS, ENDSBS, CHGUSRPRF,
CRTUSRPRF, DLTUSRPRF, CHGSYSVAL, ENDTCP, QCAPCMD). A policy's `command_files:` (commands-only YAML,
for a change-management product's table shared between companies) and then its own `commands:`
merge over the built-ins. An entry may set `library:` (the product library it must be qualified
to, else `danger`) and `class_by_param: { param, values: {VALUE: class}, default }`; any class
named there becomes a rule-addressable custom class.

### D4. Policy shape, with the owner's model in invented names
```yaml
version: 1
mode: { default: observe, prod: enforce }
partitions:
  - { name: dev,  systems: [DEVBOX],  rdbs: [DEVRDB] }
  - { name: qa,   systems: [QABOX],   rdbs: [QARDB, QAIASP1] }   # mirror of prod
  - { name: prod, systems: [PRODBOX], rdbs: [PRODRDB] }
unknown_partition: prod
command_files: [cm-product.yaml]          # e.g. CMPRM with class_by_param LEVEL → promote_qa
environments:                             # one list, first match wins
  - { name: scratch,    libraries: [QTEMP] }
  - { name: personal,   match: ["${USER}", "${USER}_*"], partitions: [dev] }
  - { name: blocked,    libraries: [PAYLIB] }
  - { name: test,       match: ["QT*"], partitions: [qa] }      # before system, so Q* does not swallow it
  - { name: system,     match: ["Q*", "SYS*"] }
  - { name: devlibs,    match: ["DV*", "CR*"], partitions: [dev] }  # incl. per-ticket libs
  - { name: integ,      match: ["IN*"], partitions: [dev] }
  - { name: stage_qa,   match: ["SQ*"], partitions: [dev] }
  - { name: stage_prod, match: ["SP*"], partitions: [dev] }
  - { name: live,       match: ["LV*"] }
roles:                                    # a user holds every role that matches
  - { name: qa,         groups: [GRPQA], authlists: [AUTLQA] }
  - { name: dev,        groups: [GRPDEV] }
  - { name: contractor, users: ["CTR*"] }
  - { name: analyst,    groups: [GRPANL] }
default_role: analyst
rules:                                    # first match wins; omitted key or `any` = anything; unmatched = deny
  - { classes: [danger], decision: deny }
  - { env: blocked, decision: deny }
  - { env: scratch, classes: [read, write, ddl], decision: allow }
  - { roles: [contractor], classes: [read], env: [personal, devlibs, integ], decision: allow }
  - { roles: [contractor], decision: deny }
  - { roles: [dev, qa], partition: dev, env: [personal, devlibs, integ], decision: allow }
  - { roles: [qa], partition: dev, classes: [promote_qa], decision: allow }
  - { roles: [qa], partition: qa, env: test, classes: [read, write, call], decision: allow }
  - { roles: [dev, qa], classes: [liblist], decision: allow }
  - { classes: [read], decision: allow }
```
`${USER}` cannot collide with a library name (`{` is never legal in one) and matches the verbs'
`${p}` syntax; `any` replaces `*` as the match-anything word so no value needs YAML quoting except
library patterns, which validation tells the user to quote.
- *Why ordered rules:* they read top-down like a firewall, take exceptions without restructuring,
  and leave one precedence rule to learn. *Why one environment list:* a blocked library is listed
  once, not once per partition.

### D5. Identity and partition, once per connection
SQL connection: `CURRENT SERVER`; `QSYS2.USER_INFO` (group, supplemental groups) and
`QSYS2.AUTHORIZATION_LIST_USER_INFO` for `CURRENT USER` (internal, not decided). 5250 session: the
sign-on screen's `System . . . :` field. `systems:` matches the System name, `rdbs:` the RDB name;
both and any `IBMI_PARTITION` must map to one partition. Cached per server.

### D6. Screen hook before AID keys
`Session.pressKey(key, reporter, { guarded })`: when `guarded` (set by the tool layer, never by the
engine's own sign-on/recovery/sign-off calls) and the screen has a command line with text, await
`guard('screen_command', text, server)` before sending. `typeInto` keeps today's sync
`assertCommandAllowed` as the engine's own check. `session_open` awaits the guard for
`program`/`library` before typing sign-on fields.

### D7. Confirmation
All `confirm` operations of one tool call are gathered into one `elicitInput` with schema
`{ confirm: boolean }`, `{ timeout: 120_000 }`; accept requires `content.confirm === true`.
- *Rejected — a local browser confirmation page for clients without elicitation:* an agent with
  shell or HTTP tools can submit it itself, so it would look like a human check without being one.
  Without elicitation, `confirm` means deny; teams use observe mode while they settle their rules.

### D8. Run log
`<first config dir>/runs/YYYY-MM-DD.jsonl`, appended synchronously; `redact()` applied to statement
text; policy hash = SHA-256 of the policy text, the shipped commands.yaml and each command file's
text; each line also stores the identity and the lookup answers used, so it can be replayed.

### D9. Policy tests and replay as a CLI on the server package
`ibmi-agent-kit policy test <policy> <tests>` and `ibmi-agent-kit policy replay <candidate>
[--since N]` are subcommands of the same `bin`; with no subcommand it serves MCP. Both call
`decide` with an offline `lookups` built from the test case or log line. `policy_check` with
`policy`/`as` uses the same path. A company's private repo runs `policy test` in its CI.

## Risks / Trade-offs

- [Tokenizer under-classifies a construct] → unrecognised heads and tails → `danger`; table tests
  cover every bypass from the design reviews.
- [Lookups add round trips] → only for changed objects, long names and `*CURLIB`; cached per batch.
- [`CURRENT SERVER` is admin-set and may equal on a cloned mirror] → `systems:` + `rdbs:` +
  `IBMI_PARTITION` must agree.
- [A reconnect after the 10-second reset drops QTEMP and the library list] → decisions use fresh
  lookups per call; `run_script` reports the reset and stops.
- [Holding every matching role widens what dual-role users can do] → intended (they have both jobs);
  rules stay first-match, so a deny placed earlier still wins.
- [Change-management products differ widely] → `class_by_param` and `command_files` keep product
  knowledge in data; the bootstrap skill (`config-bootstrap`) helps write it.

## Migration Plan

Additive and observe-only by default. A team copies a template, keeps `mode: observe`, adds policy
tests, reviews the run log and a `policy replay` of its draft, then enforces partition by partition.

## Open Questions

- Whether `CURRENT SERVER` returns a usable name on PUB400; the sign-on System field and the
  profile declaration are the fallback and cross-check.
