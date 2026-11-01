# Design

## Context

`setupCli` in `packages/server/src/setup-cli.ts` sets `keep = cur.IBMI_PASSWORD` (line 235) under
the comment "The current password belongs to the current host: on another host it is asked
again, never kept". Only the company-repo branch then clears `keep` when `cur.IBMI_HOST` differs
from the skeleton's host (lines 236-242). In personal mode the host is asked later, inside the
prompt `try` (line 255), after `keep` is fixed, so the password prompt at line 257 offers the old
password whatever host was typed.

## Goals / Non-Goals

**Goals:**
- One host-change rule for both modes, applied after the host is known and before the password
  prompt.

**Non-Goals:**
- Resetting other per-host lines of a personal profile (see proposal, Out of scope).
- Host normalisation.

## Decisions

1. **One shared check after the host is known.** Personal mode takes the host from the host prompt,
   company-repo mode from the skeleton. After that value is pushed and before the user prompt:
   `if (host !== cur.IBMI_HOST) { keep = undefined; if (cur.IBMI_HOST) out("IBMI_HOST <old> is replaced by <new>\n"); }`.
   The repo branch's own copy of the check (lines 238-241) goes, so the rule lives in one place.
   Repo-mode output order stays: partition/host line, replaced line, user prompt (the existing
   test at `setup-selfcheck.ts:251` pins it). Alternative: add a second copy of the check in the
   personal `else` branch only. Rejected: two copies of a security rule drift.
2. **Exact string comparison**, as company-repo mode already does. The host answer is trimmed by
   `required()`. A case-only or spelling difference (`PUB400.COM` versus `pub400.com`) counts as a
   change; the cost is one re-typed password, and it fails safe. Alternative: case-insensitive
   compare. Rejected: no gain worth a second notion of "same host".
3. **No host in the old file counts as a change.** `undefined !== host`, so a profile that holds
   a password but no host never offers it. No replaced line is printed then (nothing to replace).
4. **The user stays offered.** `IBMI_USER` is not a secret, is shown in brackets and the user can
   type another one; the same user on several systems is common. Only the password is a
   credential that must not cross hosts. No other credential is stored by `setup`.
5. **Prompt wording unchanged**: `password (Enter keeps the current one): ` when kept,
   `password: ` otherwise, exactly as today.

## Risks / Trade-offs

- [A user who retypes the same host in another case must retype the password] → acceptable, safe
  direction.
- [Stale `IBMI_MAPEPIRE_CA` or ports from the old host stay in a personal profile] → the
  connection test fails and says why; out of scope here.
