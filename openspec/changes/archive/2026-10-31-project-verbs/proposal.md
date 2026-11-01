# Proposal

## Why

Developers and QA repeat the same multi-step checks — seed a record, call a program, check the
result, clean up — for smoke and unit tests after every build or promotion. Written as ad hoc
scripts they are retyped, unreviewed and unsafe to share. People need their own named,
parameterised procedures, teams need shared ones that live in the application repo and are
reviewed like code, and every one must run through the guard so sharing it grants nothing.

## What Changes

- New **verbs**: one YAML file each, with typed parameters and `setup`, `steps` and `cleanup`
  lists of SQL, CL, `expect` and nested-verb steps.
- Three **layers**, closest first: `user:` (`~/.ibmi-agent-kit/verbs`, one person's own),
  `proj:` (`.ibmi-kit/verbs/` in the server's working directory, plus folders in
  `IBMI_KIT_VERBS`), `org:` (`verbs/` beside the policy file). A bare name resolves to the closest
  layer that has it, so a person can override a team verb for themselves.
- Every statement is classified and decided by the guard as the signed-on user after parameter
  substitution; a verb never adds permission.
- `expect` steps check SQL results; setup steps can require that their test data is absent first;
  `cleanup` undoes only setup steps that succeeded.
- `verb_run` runs one verb or every verb with a tag as a suite; `policy_check` (from
  `execution-guard`) also accepts a verb and arguments.

### MCP tools added or changed

| Tool | Annotation | Change |
|---|---|---|
| `verb_list` | read-only | new: verbs by layer, tags, parameters, and which are overridden |
| `verb_run` | destructive | new: one verb, or `tag:` to run a suite |
| `policy_check` | read-only | also accepts `verb` and `args` |

## Out of scope

- Verbs defined or saved by the agent through a tool; verbs are files a person writes.
- 5250 screen steps in verbs, RPGUnit integration, JUnit output and CI service profiles.
- Any change to the policy's decisions: verbs are subject to it, never configure it.

## Capabilities

### New Capabilities
- `verbs`: verb files, layers, parameters, steps, expectations, cleanup, and the verb tools.

### Modified Capabilities
- `policy-testing` (from `execution-guard`): test cases may name a verb and arguments instead of a
  script. (`guarded-tools` gains `policy_check` verb input in this change's tasks; that requirement
  already names it.)

## Impact

- Verb schema, loader and substitution in `packages/guard`; runner and tools in `packages/server`,
  executing through the transport's `query`, `execute` (bound parameters) and `cl`.
- New setting `IBMI_KIT_VERBS`. Depends on `unified-kit` and `execution-guard`.
