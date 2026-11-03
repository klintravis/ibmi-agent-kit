# Tasks

Selfchecks use a fake store (`setCredentialStore`) and a fake MCP client over `InMemoryTransport`; no real OS store
and no IBM i. Run `npm run clean && npm run check` after each group.

## 1. Extract the profile writer

- [x] 1.1 Move the shared logic listed in design D8 from `packages/server/src/setup-cli.ts` to `packages/server/src/profile-write.ts`, keeping its error handling and validation; `setupCli` calls it. Verify: `setup-selfcheck.ts` passes with no test changed.

## 2. Core seam

- [x] 2.1 Add `setSignOnPage` and a typed missing-entry error to `packages/core/src/credential.ts`, keeping the message text; call the hook on a missing entry and at the latch refusal of a store profile (D1). Verify: core selfcheck, hook gets `missing` and `rejected`, is never called for helper, plain or an unreadable store, and `send` is not called; with no hook every message is unchanged.
- [x] 2.2 Add the `list_servers` line to the unknown-server error when no profile exists and the hook is installed. Verify: core selfcheck, and the existing `Available: ...$` checks in core and screen pass unchanged.

## 3. Page server

- [x] 3.1 Add `packages/server/src/signon-page.ts`: lazy listener, pages per key, GET form and POST submit with the protections in D4, the password path through `storeSecret`, and the re-offer count in D6. Verify: group 5 selfchecks.
- [x] 3.2 Add the first-profile form and submit through `profile-write.ts`: skeleton or typed host, partition list, refusals in D8, no overwrite of a profile that has appeared. Verify: group 5 selfchecks.

## 4. Delivery and wiring

- [x] 4.1 Add the offer logic in D3: elicitation fired and not awaited, a random `elicitationId` that is not the token, 10-second window, link fallback with the hand-to-user text and the terminal route, and the completion notifier. Verify: group 5 selfchecks.
- [x] 4.2 Return the page from `createServer` on `KitServer`, join it to `engines`, and install the hook in `serve()`. Verify: a selfcheck that `createServer` alone installs no hook, and that shutdown closes the listener.
- [x] 4.3 Make the `list_servers` handler carry the first-profile offer when no profile exists, and keep `readOnlyHint`. Verify: selfcheck on the text, and the existing `No profiles found` check still passes or is updated with the new wording.
- [x] 4.4 Confirm the engines need no change. Verify: `git diff --stat main -- packages/screen packages/source` is empty; if a file there must change, add its `Modified by ibmi-agent-kit (2026)` line.

## 5. Selfchecks

New `packages/server/src/signon-selfcheck.ts`, imported by `selfcheck.ts`, in the existing style. HTTP requests go to the real loopback listener.

- [x] 5.1 Token: GET does not consume; an accepted POST does; a second POST is refused and the fake store is not written; an expired token is refused (injected clock); a new offer gets a new token.
- [x] 5.2 Refusals: wrong Host, missing or wrong token, foreign Origin, token only in the query string, GET with values in the query string ignored, oversized body. Headers: no-store, CSP, referrer policy, on every response including refusals.
- [x] 5.3 Secret absent: submit a marker password, then run accepted, store-failed and rejected paths; assert the marker is in no tool result, notification sent to the client, run log file, captured stderr or page response.
- [x] 5.4 Delivery: fake client without `elicitation.url` gets the link and no request; a client with it gets no link in the first error; a decline, a request error and 10 seconds unanswered each print the link for the same page; form mode is never requested; the link holds no host, user or profile name; the completion notification fires after a submit of an elicited page and not after a link-only one.
- [x] 5.5 No extra attempt: count `send` calls. Missing entry sends 0; a guarded identity lookup plus query makes one page and sends 0; a submission sends 0; the next call sends 1; a rejected value retried sends 0.
- [x] 5.6 Re-offer: stale entry rejected, then page, then rejected, then no page; first-time page, then rejected, then page, then rejected, then no page; an expired offer does not count; helper and plain profiles get no offer.
- [x] 5.7 First profile: no repo writes `.env` with `IBMI_PASSWORD_STORE=os` and no password; one skeleton and several skeletons; skeleton password and helper never copied and warned; a skeleton with no host refused; a line break in a value refused; policy path set; store failure writes no file; profile folder in a git work tree and in the repo refused; a profile that appears after the offer is not overwritten; a typo with profiles present stays the existing error; HTML in a value is escaped.
- [x] 5.8 Standalone: with no hook installed, the engines' missing-entry and unknown-server texts are unchanged.

## 6. Docs

- [ ] 6.1 `packages/server/README.md`: a "Sign-on page" section (what it does, the protections, `QMAXSIGN`, the re-offer limit, per-process limit, headless and Linux routes, what agents can and cannot do with the link); link it from Passwords, A wrong password is sent once and `setup`; the `list_servers` row in Tools it owns. Verify: `docs-check` (run by the desk's repo check at finish) reports no gap.
- [ ] 6.2 Root `README.md` install path: the page as the first sign-on route and `setup` as the terminal route. Verify: `docs-check` reports no gap.
- [ ] 6.3 `docs/demo.md` and `.claude/skills/demo/SKILL.md`: the page route at the profile step, the `default` profile afterwards, keeping "never ask for the password" and the `setup` command. Verify: the demo selfcheck passes.
- [ ] 6.4 Run `node scripts/check-names.mjs` and the full check. Verify: both exit 0.

## Live verification (owner only, not run by agents)

Not tracked as tasks: these need a person and a real machine. Record them as a desk todo at handoff.

- Real browser: open the link, submit, retry, and see the sign-on succeed; check the form in a browser that offers to save passwords.
- Real OS store on Windows, macOS and Linux with Secret Service; Linux without Secret Service shows the message.
- Claude Code CLI: the URL prompt appears, and an elicitation sent outside a request reaches it (the hook has no `relatedRequestId`).
- VS Code extension: whether it prompts or silently declines; the fallback link works either way.
- Real sign-on against a box, with a wrong password on a throwaway user only, to see the re-offer. Never on a shared system without its owner's consent.
