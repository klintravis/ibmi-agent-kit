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
statement, gathers every `confirm` into one elicitation, and only then runs requires_absent →
setup → steps → cleanup through `run_script`'s executor.

### D3. Cleanup bookkeeping and resets
The runner records succeeded setup ids; a cleanup entry runs iff its `undoes` id is in that set.
Cleanup failures are collected, never thrown. On a transport reset the verb fails, cleanup runs
on a fresh connection, and the result notes lost QTEMP and library list state.

### D4. Loading and layers
At startup: `~/.ibmi-agent-kit/verbs` (`user`), `<cwd>/.ibmi-kit/verbs` and `IBMI_KIT_VERBS`
(`proj`), `<policy dir>/verbs` (`org`). Strict zod schemas; cycle and depth checks across layers.
Bare names resolve `user` → `proj` → `org`.
- *Why closest-wins rather than refusing collisions:* a person can try a variant of a team verb
  without editing the shared file; `verb_list` makes the override visible.

### D5. Fewer tools
`verb_check` folds into `policy_check` (`verb`, `args`); `verb_test` folds into `verb_run` (`tag`).

## Risks / Trade-offs

- [`${}` is still text substitution] → only from closed lists or validated scalar types, and every
  substituted statement is classified by the guard.
- [A personal verb overrides a team verb silently in someone's runs] → `verb_list` marks it and
  the run log records the verb's layer and file.
- [Suites collide on shared test libraries] → `requires_absent` fails fast instead of corrupting.

## Migration Plan

Additive; no verbs load unless the folders exist.
