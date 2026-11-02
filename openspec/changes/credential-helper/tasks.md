# Tasks

Do in order. `design.md` holds the reasons and the exact helper options. Put a
`// Modified by ibmi-agent-kit (2026): ...` line on every file changed under `packages/screen` or
`packages/source`. Fake helpers in selfchecks are small node scripts run through `process.execPath`, so
they work on all CI legs. No selfcheck touches the real store, a live box or a profile folder of the user.

## 1. Dependency

- [ ] 1.1 Rebase on `origin/main` once `zod4` has merged (both change `package-lock.json`). If it has not merged, go on and rebase later.
- [ ] 1.2 Add `@napi-rs/keyring` to `packages/core`, exact pin `2.1.2`. Confirm with `grep` that `package-lock.json` keeps the optional entries of all platforms (npm can drop them), and that `npm audit` shows nothing new against `main`.

## 2. Core: `packages/core/src/credential.ts`

- [ ] 2.1 Add `IBMI_PASSWORD_COMMAND` and `IBMI_PASSWORD_STORE` to `PROTECTED`. `resolveProfileEnv` sets `IBMI_KIT_PROFILE_FILE` after the file overlay.
- [ ] 2.2 `passwordSource(env)`: the fields for `loadProfile`; errors on a `STORE` value other than `os` and when no source exists, naming `IBMI_PASSWORD_STORE` or `IBMI_PASSWORD_COMMAND`.
- [ ] 2.3 Splitter and `.cmd`/`.bat`/`.ps1` refusal, exported for `setup`.
- [ ] 2.4 Helper runner per `design.md`: no shell, `cwd: homedir()`, stderr dropped, timeout, `maxBuffer`, BOM and one line ending removed, try/catch around the spawn. Errors name only the executable and the exit code or reason.
- [ ] 2.5 Git work tree check at fetch time: `realpath` of the profile file, walk up for `.git`.
- [ ] 2.6 Store: lazy import, service `ibmi-agent-kit`, account `USER@host`, `{ linux: { store: 'secret-service' } }`, errors wrapped with the pointer to `credential set` or `IBMI_PASSWORD_COMMAND`. `setCredentialStore(fake)` as the in-process test seam.
- [ ] 2.7 `fetchSecret` (precedence, no fallback, one warning per process for a plain line), `signOnOnce` (promise chain per key, latch, refusal text from the spec), `lastSecret`, and a test-only `resetSignOnState()`. Export from `index.ts`. The latch is process-wide state and selfchecks share a process: reset between tests.
- [ ] 2.8 Core selfchecks: helper success, trailing newline, trailing space kept, non-zero exit, empty output, timeout, `.cmd` refusal, secret absent from every error, split cases including quoted Windows paths, cwd is home, git refusal including the spoofed key, precedence and no fallback, env cannot set the keys, store key by `USER@host`, helper not run by `resolveProfileEnv`. Latch: same secret refused without send, changed secret sent, success clears, non-auth failure not recorded, concurrent attempts send once.
- [ ] 2.9 Selfcheck that loads `@napi-rs/keyring` and constructs an entry without touching the store, so a missing platform binary fails CI.

## 3. Engines and server

- [ ] 3.1 `Profile.password` optional plus the new fields in `source/src/types.ts` and `screen/src/types.ts`. Both `loadProfile` use `passwordSource`. Update the selfchecks that assert the old missing-password text. Existing selfchecks that simulate a rejected sign-on (the `session.ts:328` branch, an ssh `client-authentication` case) now latch the fixture's user and host, so later tests fail without sending: call `resetSignOnState()` between them.
- [ ] 3.2 `transport.ts:48`: `signOnOnce`, rejected on `/\b401\b|authentication/i`. Add a comment that the daemon text is unconfirmed live.
- [ ] 3.3 `sshMapepire.ts:90`: `signOnOnce`, rejected on `level === "client-authentication"`. Reword `describeConnectError` so it no longer names only `IBMI_PASSWORD`.
- [ ] 3.4 `session.ts:302`: `signOnOnce` around type, Enter and result check, rejected on `sign on failed` and `still on the sign on screen`.
- [ ] 3.5 `guarded.ts:441,552`: `secret: conn.profile.password ?? lastSecret(host, user)`.
- [ ] 3.6 Selfchecks at the seams, with a fake `send` or transport: a guarded SQL call with a rejected sign-on sends once (the `readBox` double send), `run_tests` over three suites sends once, helper not run by the policy path, partition and verb reads, run log masks a helper's secret.
- [ ] 3.7 Check tool output and `list_servers` still expose no source field: the new `Profile` fields do not reach any output. `passwordCommand` is not a secret but stays out of output anyway.

## 4. setup and `credential`

- [ ] 4.1 `updated()` can delete lines. Removed keys also leave `want` for the drift check.
- [ ] 4.2 `OWN` gains both keys. Warn when a skeleton holds `IBMI_PASSWORD_COMMAND`, as for a skeleton password.
- [ ] 4.3 The source prompt, per the spec: store with keep or migrate on the same host and user; helper with split, `.cmd` and git checks before any write; store write before the file write. Reword the company-repo `leak` message.
- [ ] 4.4 `scrub` also masks `lastSecret`. Test once through the existing `deps.connect`.
- [ ] 4.5 `credential set|delete <profile>` in `server/src/credential-cli.ts`, dispatched in `index.ts`: hidden prompt or one stdin line, extra argv is exit 2, profile file untouched, hint when the profile has no `IBMI_PASSWORD_STORE=os`.
- [ ] 4.6 Every scripted setup selfcheck gains the source prompt, and its default answer writes the store, so install a fake store first (`deps` store defaulting to the real one, as `deps.connect` does): no test may reach the real store. Helper-profile fixtures go in an `mkdtemp` folder, never under the checkout, which is a git work tree and would trigger the refusal. Update those that expect `IBMI_PASSWORD` in the file. Add: default store, helper chosen, hostile helper round-trip, migration removes the line, store failure writes nothing, skeleton helper not copied or run, keep rules on host or user change, scrub of a helper's secret, password on argv refused, `credential` set and delete with a fake store.

## 5. Docs

- [ ] 5.1 `README.md` (lines 42, 44, 96), `packages/server/README.md` (64, 72, 82-87), `packages/core/README.md` (26), `packages/source/.env.example` (7), `docs/demo.md` (11, 26, 47, 100, 148): setup offers the store or a helper; `credential set|delete`; rotation.
- [ ] 5.2 `packages/server/README.md`: helper rules (no shell, `.cmd` refusal, quoting with the single-quote rule for a value starting with a quoted path or holding `#`, git work tree refusal, precedence), try-once behaviour and its limit, the Windows Credential Manager example from `design.md`, Linux needing a Secret Service.
- [ ] 5.3 `templates/company-repo/README.md` (33, 40-42, 75-77, 242) and `.claude/skills/ibmi-kit-config/SKILL.md` (21-22, 110, 113): no helper line in a skeleton; each user chooses a source at `setup`.

## 6. Check

- [ ] 6.1 `npm run clean && npm run check`, `node scripts/check-names.mjs`, and the desk's `docs-check`, all exit 0.
- [ ] 6.2 Add a line to the report for the owner to check live, not done by the stream: the store on the real Windows box, and a daemon's wrong-password text (a deliberately wrong password burns one attempt, so use a test profile, never PUB400 unasked).
