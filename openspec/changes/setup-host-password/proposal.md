# Proposal

## Why

Outside a company config repo, `ibmi-agent-kit setup <name>` on an existing profile lets the user
type a new host, then offers "Enter keeps the current one" at the password prompt. Enter writes
the old host's password into the profile and the connection test sends it to the new host. In
company-repo mode a changed host already forces a fresh password; the personal path skips that
check.

## What Changes

- When the host answered at the host prompt differs from the profile's current `IBMI_HOST`
  (or the profile has no host yet), `setup` no longer offers to keep the current password: the
  prompt reads `password: ` and Enter asks again. The old password is neither written nor sent.
- In that case `setup` prints `IBMI_HOST <old> is replaced by <new>`, the line company-repo mode
  already prints, so the user sees why the password is asked.
- Host unchanged: Enter still keeps the current password, as today.
- The user name stays offered as the bracketed default on any host (it is not a secret and is
  shown, so the user decides).
- No MCP tool is added or changed: this is the `setup` CLI only.

## Out of scope

- Other per-host settings an existing personal profile keeps when its host changes
  (`IBMI_MAPEPIRE_CA`, `IBMI_MAPEPIRE_PORT`, `IBMI_SSH_PORT`, `IBMI_PARTITION`, guards). `setup`
  keeps every line it does not ask about by design; a stale CA makes the connection test fail
  rather than leak anything.
- Treating host spellings as equal (case, trailing dot, IP versus name). A different spelling
  only re-asks the password.
- Company-repo mode behaviour, which already meets the rule.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `server-profiles`: adds a requirement that `setup` keeps a stored password only for the same
  host, in both personal and company-repo mode.

## Impact

- Code: `packages/server/src/setup-cli.ts` (the host-change check moves after the host is known,
  shared by both modes).
- Tests: `packages/server/src/setup-selfcheck.ts` (one new test, one assertion added to the
  existing update test).
- Docs: `packages/server/README.md`, `setup` command step 2.
- No dependency, profile format or MCP tool change.
