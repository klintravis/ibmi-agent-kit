# Proposal

## Why

Developers and QA repeat the same multi-step checks — seed a record, call a program, check the
result, clean up — for smoke tests and unit tests after every build or promotion. Written as ad
hoc scripts they are retyped, unreviewed and unsafe to share. A team needs named, parameterised
procedures that live in the application's own repo, are reviewed like code, and run through the
same guard as everything else, so sharing one never grants anyone more than they already have.

## What Changes

- New **verbs**: YAML files in an application repo's `.ibmi-kit/verbs/` folder (layer `proj:`)
  and in the company policy repo (layer `org:`), each a named procedure with typed parameters
  and `setup`, `steps` and `cleanup` lists of SQL, CL, `expect` and nested-verb steps.
- Every step is classified and decided by the execution guard as the signed-on user, after
  parameter substitution. A verb never adds permission.
- `expect` steps check SQL results or row counts, and fail the verb when they do not hold.
- `cleanup` runs after success or failure, but only undoes setup steps that succeeded.
- Tools to list, run and test verbs; a tag-based suite runner for smoke and unit tests.

### MCP tools added or changed

| Tool | Annotation |
|---|---|
| `verb_list` — verbs available, with layer, tags, parameters | read-only |
| `verb_check` — classify and decide every step of a verb for given arguments, without running | read-only |
| `verb_run` — run one verb | destructive |
| `verb_test` — run every verb with a tag as a suite | destructive |

## Out of scope

- Session verbs defined by the agent, personal verbs, and saving verbs from a tool call: verbs
  enter a repo only through a human commit.
- 5250 screen steps in verbs, RPGUnit integration, JUnit output and CI service profiles.
- Any change to the policy's decisions: verbs are subject to it, never configure it.

## Capabilities

### New Capabilities
- `verbs`: verb files, layers, parameters, steps, expectations, cleanup, and the verb tools.

### Modified Capabilities
- None.

## Impact

- New verb loader and runner in `packages/guard` (format, validation, substitution) and
  `packages/server` (tools, execution through the source engine).
- New setting `IBMI_KIT_VERBS` (folders to load, platform path delimiter); the org layer is the
  folder `verbs/` beside the policy file.
- Depends on changes `unified-kit` and `execution-guard`.
