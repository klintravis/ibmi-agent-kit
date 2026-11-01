## Why

`openspec validate --all --strict` warns on three requirements over 500 characters. Splitting them
makes the specs validate clean.

## What Changes

- `execution-policy`: the observe-mode requirement keeps its core rule; the unknown-command
  exception and its stated limit move into scenarios.
- `statement-classification`: "Changed objects name their library" and "CL commands come from a
  closed table" each keep a short SHALL statement; the edge cases move into scenarios.
- No behaviour changes: every statement and scenario is kept. No MCP tools added or changed.

## Out of Scope

Any change to code or to what the guard decides.

## Impact

`openspec/specs/execution-policy` and `openspec/specs/statement-classification` only.
