## Why

A first enterprise install rules out plain-text passwords, yet `IBMI_PASSWORD` in the profile file is
the only source today and `setup` writes it. A wrong password is also dangerous: IBM i disables a user
profile after `QMAXSIGN` failed sign-ons, and one guarded SQL tool call sends a bad password twice
today (`readBox` swallows the failure, then the tool's query signs on again), so the kit must try once.

## What Changes

- New file-only profile key `IBMI_PASSWORD_COMMAND`: an executable plus arguments, run with no shell,
  whose stdout is the password. Refused when the profile sits in a git work tree.
- New file-only profile key `IBMI_PASSWORD_STORE=os`: the password lives in the OS credential store
  (Windows Credential Manager, macOS Keychain, Linux Secret Service) through `@napi-rs/keyring`.
- The secret is fetched only when a password is about to be sent, once per send, never on non-secret
  reads of the profile.
- New rejected-password latch, for plain profiles too: a password the box rejected is not sent again
  by this process until it changes, at all three send points.
- `setup` never writes a plain password: it offers the OS store (default) or a helper command, tests
  once, and removes an old `IBMI_PASSWORD` line. It does not copy helper lines from a company skeleton.
- New `ibmi-agent-kit credential set|delete <profile>` for password rotation. There is no `get`.
- An existing `IBMI_PASSWORD` line keeps working, with a warning on stderr. Not a breaking change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `server-profiles`: password sources, fetch rules, helper execution, git work-tree refusal, OS store,
  `credential` subcommand, try-once latch, and the `setup` flow.

## Impact

- `packages/core`: new `src/credential.ts`, `PROTECTED` gains two keys, new dependency
  `@napi-rs/keyring` (exact pin, lazily imported; Linux binaries link libdbus, `AFL-2.1 OR GPL-2.0-or-later`).
- `packages/source` and `packages/screen`: `loadProfile`, `Profile.password` becomes optional, the send
  points in `transport.ts`, `sshMapepire.ts`, `session.ts`.
- `packages/server`: `guarded.ts` run-log secret, `setup-cli.ts`, new `credential` dispatch in `index.ts`.
- Docs: root README, `packages/server/README.md`, `packages/core/README.md`,
  `templates/company-repo/README.md`, `ibmi-kit-config` skill, `docs/demo.md`,
  `packages/source/.env.example`.
