# Design

## Context

After `execution-guard`, the server has `classify`/`decide`, gathered confirmation, the run log,
and `run_script`'s executor over the transport's `query`, `execute(sql, params)` and `cl`. Verbs
are a named, parameterised wrapper around that same path.

## Goals / Non-Goals

**Goals:** verbs as files people write; zero new permission paths; safe test-data handling;
deterministic tests with a stub transport.

**Non-Goals:** a scripting language (no loops, branches or variables beyond parameters); screen
steps; tools that author verbs.

## Decisions

### D1. Verb file shape
```yaml
name: SMOKE-ORDERS
description: Order validation still accepts a new order
tags: [smoke]
params:
  env:   { type: string, default: IN1, allowed: [IN1, IN2] }
  order: { type: integer, default: 999001 }
setup:
  - id: seed
    requires_absent: "SELECT 1 FROM ORD${env}.ORDHDR WHERE OHORD = :order"
    sql: "INSERT INTO ORD${env}.ORDHDR (OHORD, OHCUS) VALUES (:order, 'TEST01')"
steps:
  - cl: "CALL PGM(ORD${env}/ORDVAL) PARM('${order}')"
  - expect:
      sql: "SELECT OHSTS FROM ORD${env}.ORDHDR WHERE OHORD = :order"
      equals: { OHSTS: V }
cleanup:
  - undoes: seed
    sql: "DELETE FROM ORD${env}.ORDHDR WHERE OHORD = :order"
```
- `:p` → `?` with the value appended in order, sent through `execute`/`query` as bound parameters.
- `${p}` → text, only for `allowed` lists or validated numeric/date/boolean values; inside CL
  string literals single quotes are doubled (relevant only to `allowed` strings containing one).
- `requires_absent` makes the cleanup safe on files without a unique key: the verb only deletes
  rows it proved were not there before.

### D2. Decide everything, confirm once, then run
`verb_run` substitutes all three lists (and nested verbs, at most 5 verbs in one call chain, the top one counted), classifies and decides every
statement, gathers every `confirm` into one elicitation, and only then runs setup (each step's
requires_absent just before it, so it can query a table an earlier setup step created) → steps →
cleanup through `run_script`'s executor, with its time limit on queries (SELECT, VALUES and WITH
steps too). `requires_absent` and `expect` queries must classify as reads only. A `tag` suite plans
every verb and decides them all as ONE script in run order, so one verb cannot set up what lets the
next past the guard (a QTEMP alias, `CHGCURLIB`); it asks once, and a declined confirmation runs
none. The call is one run-log call, as decided.

### D3. Cleanup bookkeeping and resets
The runner records succeeded setup ids; a cleanup entry runs iff its `undoes` id is in that set.
Cleanup failures are collected, never thrown. Every send carries the job generation the call was
decided on. After a connection reset nothing more is sent, cleanup and later verbs included, on
the old job or a new one: the result says "connection reset; nothing more was sent; cleanup not
run:" with the cleanup statements left undone, for the user to run by hand.
- *Why not clean up on a new job:* its QTEMP, library list and current library differ, so the
  cleanup would need deciding again on state the verb never saw; a person cleaning up knows more.

### D4. Loading and layers, on a server's first verb call
`~/.ibmi-agent-kit/verbs` (`user`), `<cwd>/.ibmi-kit/verbs` and the profile's `IBMI_KIT_VERBS`
folders, which must be absolute (`proj`), `<policy dir>/verbs` beside the profile's
`IBMI_KIT_POLICY` (`org`). Strict zod schemas; cycle and depth checks across layers.
Bare names resolve `user` → `proj` → `org`.
- *Why closest-wins rather than refusing collisions:* a person can try a variant of a team verb
  without editing the shared file; `verb_list` makes the override visible.
- `IBMI_KIT_VERBS` is a profile setting, so the server loads a server's verbs once, on that
  server's first verb call, and never reloads them. `policy test` reads only `proj` (its working
  directory) and `org` (beside the policy under test), so CI never depends on a person's verbs.

### D5. Fewer tools
`verb_check` folds into `policy_check` (`verb`, `args`, live or offline with `as`), where a
`requires_absent` or `expect` query that does more than read shows as deny; `verb_test` folds into
`verb_run` (`tag`). A `tag` suite skips a verb a closer layer overrides (a bare name never reaches
it), and reports it as skipped. Its later verbs are decided as if every earlier one ran in full, so
the suite sends a later verb only if every earlier verb in the call did run in full: once one is
refused, hits its `requires_absent`, fails or stops early, the rest are reported "not sent: an
earlier verb in this call did not run in full" (that verb's own cleanup still runs).
- *Why not re-decide the rest:* simplest safe rule; a suite of smoke tests that fails early has
  already answered its question.

## Risks / Trade-offs

- [`${}` is still text substitution] → only from closed lists or validated scalar types, and every
  substituted statement is classified by the guard.
- [A personal verb overrides a team verb silently in someone's runs] → `verb_list` marks it and
  the run log records the verb's layer and file.
- [Suites collide on shared test libraries] → `requires_absent` fails fast instead of corrupting.

## Migration Plan

Additive; no verbs load unless the folders exist.
