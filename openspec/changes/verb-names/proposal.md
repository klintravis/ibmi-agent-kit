## Why

A verb whose CL step takes a member, file or library name cannot be written: CL has no bound
values, and `${p}` is refused for a `string` parameter without an `allowed` list because it would be
free text. So a change-management checkout verb (`CMPRD/CMCHKOUT TASK(${task}) MBR(${member})`) is
impossible, though it is the most natural verb a company writes. Separately, `policy test` loads
verbs only when a test case names one, so a verb file the server would refuse at load passes CI.

## What Changes

- `verbs`: a new parameter type `name`, an IBM i object name (`^[A-Za-z$#@][A-Za-z0-9$#@_.]{0,9}$`,
  upper cased, anything else refused naming the parameter). It can hold no quote, blank,
  parenthesis, comma or `&`, so `${p}` may be used with it in CL and SQL, inside or outside quotes,
  as with `integer`. `:p` in SQL binds it as a string. `allowed` still works (values validated as
  names). The guard still decides the substituted statement, so a name that is a production library
  in a command's library slot resolves to its environment like a literal.
- `policy-testing`: `ibmi-agent-kit policy test` always loads the policy's verbs, prints each
  refusal and exits 1 when any verb file is refused, whether or not a case names a verb. A policy
  with no verb folders behaves as before.
- No MCP tool added or changed (all existing tools keep their read-only or destructive
  annotations): `verb_list` and `policy_check` show and accept the new type value only.

## Out of Scope

A user-supplied regex, any other new parameter type, free-text strings in CL, changes to what the
guard classifies or decides.

## Impact

`packages/guard/src/verbs.ts`, `packages/server/src/policy-cli.ts`, their selfchecks,
`docs/verbs.md`, and the verb and policy-test lines of `packages/server/README.md` and
`packages/guard/README.md`.
