# Design

## Context

After `execution-guard`, the server has `classify`/`decide`, confirmation, the run log and
`run_script` execution through the source engine. Verbs are a named, parameterised wrapper
around that same path.

## Goals / Non-Goals

**Goals:** verbs as reviewable files; zero new permission paths; deterministic tests with a stub
backend.

**Non-Goals:** a scripting language (no loops, branches or variables beyond parameters); screen
steps.

## Decisions

### D1. Verb file shape
```yaml
name: SMOKE-ORDERS
description: Order validation still accepts a new order
tags: [smoke]
params:
  env:   { type: string, default: IT1, allowed: [IT1, IT2] }
  order: { type: integer, default: 999001 }
setup:
  - id: seed
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
- `${p}` = textual substitution, allowed only for parameters with `allowed` (identifiers) or of
  type `integer`/`decimal`/`date` validated first; inside CL strings quotes are doubled.
- `:p` = SQL bound parameter marker, rewritten to `?` with the value appended in order.
- *Why two syntaxes:* it makes visible, in review, which values are bound and which become text.

### D2. Decide everything, then run
`verb_run` substitutes all three lists, classifies and decides every statement with the guard
(`deny` anywhere → refuse), then runs setup → steps → cleanup through the same executor as
`run_script`. `confirm` statements are asked when reached; a decline counts as a step failure,
which still triggers cleanup.

### D3. Cleanup bookkeeping
The runner records which setup ids succeeded; a cleanup entry runs iff its `undoes` id is in that
set. Cleanup failures are collected, never thrown.

### D4. Loading
Loaded at startup by the server from `IBMI_KIT_VERBS` folders and `<policy dir>/verbs/`; validated
with strict zod schemas; nesting graph checked for cycles and depth ≤ 5. Addresses are
`proj:NAME` / `org:NAME`; `NAME` alone is accepted only when exactly one layer has it.

## Risks / Trade-offs

- [`${}` in identifiers is still text substitution] → only from a closed `allowed` list, and the
  result is classified by the guard like any statement.
- [A project verb in a repo a user controls] → it can do no more than that user could type; review
  is the team's process control, the guard is the safety control.
- [Long suites against a shared integration library collide] → verbs own their test keys via parameters;
  documented as the team's convention.

## Migration Plan

Additive; no verbs load unless folders exist.
