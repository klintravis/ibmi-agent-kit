# Design

## Context

See proposal.md for the motivation. What shapes the approach:

- `signOnOnce` in `packages/core/src/credential.ts` is async, and all three sign-on paths go through it
  (screen `session.ts`, source `sshMapepire.ts` and `transport.ts`). It chains per account. An error raised
  before `send` passes through `sshMapepire.ts` and `transport.ts` unchanged, and it is not classed as a
  rejection.
- `resolveProfileEnv` and `loadProfileFor` are sync, and `failResult` is sync. A listener's port is only known
  asynchronously, so no link can be built at those points.
- The engine guard is not a chokepoint: `session_open` with no landing never calls it (screen `tools.ts:130`).
- `SQL_TIME_LIMIT_MS` (10 s) wraps the connect in `packages/source/src/mapepire.ts:216`, and its timeout resets
  the session. The SDK's default request timeout is 60 s. Neither leaves room to wait for a person.
- `createServer` promises to touch no process state, and `setCredentialStore` shows how core takes a seam.

## Goals / Non-Goals

**Goals:** one hook in core, one page module in the server, `setup` logic shared and not copied, and no
engine change. No path where the page itself spends a sign-on attempt.

**Non-Goals:** defending against a hostile local process running as the same user. It could already read the
profile folder and call `credential set`. The kit's guard catches mistakes, and IBM i object authority is
the real boundary.

## Decisions

### D1. Layers: a hook in core, everything else in the server

Core gains `setSignOnPage(fn | undefined)`, next to `setCredentialStore`. The hook has the shape
`(p: SignOnProfile, why: "missing" | "rejected") => Promise<string>` and returns text to append to the error.
It must not throw; a failure inside it returns `""`, so the existing error stands.

`signOnOnce` calls it in two places: when `fetchSecret` reports a missing store entry (a small typed error
from `readStored`, so an unreadable store stays a different case), and at the latch refusal when
`p.passwordStore` is set and no helper is set. Helper and plain profiles never reach it.

`packages/server/src/signon-page.ts` holds `node:http`, the tokens and the elicitation. `createServer` builds
it and returns it on `KitServer`; `serve()` calls `setSignOnPage`, so `createServer` still touches no process
state. It joins `engines`, so shutdown closes the listener.

Alternative: core imports MCP or HTTP. Rejected by the existing layering. Alternative: a check in the guard.
Rejected because it misses `session_open`.

### D2. The tool call does not wait

The hook awaits only `listen()`, then returns the offer text; the call fails with it. Elicitation is fired
without an await, with `.catch` to swallow its errors and `{ timeout: 5 min }`. The user submits, and the next
tool call reads the store and sends once. No secret was fetched, so no attempt was spent.

Alternative: block until submitted, with a timeout. Rejected: the 10 s limit would replace the link with a
timeout error and reset the session, the per-account chain would hold every other sign-on for that account,
and a silently declined client would hang. The retry loop is one extra tool call, and the client may take the
completion notification as its cue.

Limit: a rejection's own error carries no offer, because the send's error goes through each path's wrapper. The
offer comes with the next call, at the latch refusal.

### D3. Delivery: elicit first, then the link

One page per pending key: the account, or `first-profile`. A second hook call in the same tool call (guarded
identity lookup, then the query) gets the same page. The offer text depends only on this:

- Client declares `elicitation.url`, the offer is under 10 s old, and no decline or failure has arrived: say a
  prompt was offered, and to call again if none appeared. No link.
- Otherwise: print the link.

So a silent decline loses at most one call, and a client that never answers loses at most 10 s. Elicitation is
sent once per page. The link goes off the model's path only when the client really answers. An impatient retry
past 10 s shows the link, which is the safe direction for "must not lose it".

The 10 s window exists because of the guarded path: "always print on the next failure" would print the link in
the same tool call on every guarded tool, the main path.

After an accepted submission, `createElicitationCompletionNotifier` fires if the page was elicited. Its failure
is swallowed. `elicitationId` is a fresh `randomUUID()`, never the token.

Every offer also names the terminal route.

Wire format: SDK 1.32.2 negotiates at most protocol `2025-11-25`, where elicitation is a server request and the
completion notification exists. The `2026-07-28` spec keeps the form-mode ban and URL mode, but delivers the
request in an `InputRequiredResult` that the client answers by retrying the tool call, and its elicitation page no
longer shows a completion notification. This design is built on what the installed SDK speaks. Fail-and-retry
already matches the newer flow, and the link needs no protocol at all; an SDK upgrade replaces only the
`elicitInput` call.

### D4. Page protections

Same as `packages/screen/src/viewer.ts`: loopback bind, Host allowlist, random token, 403 text refusal, no-store,
CSP. Beyond the viewer:

- Port 0 and one listener, opened lazily, closed when no page is pending (5-minute timer, unref'd).
- `randomBytes(16)` token; GET `/?t=<token>` shows the form and does not consume it, so a link preview cannot
  burn it.
- POST `/` with a urlencoded body, 4 KiB cap, and the token in the body. A cross-site form passes the Host check
  by nature (Host is legitimately `127.0.0.1:port`), so the body token and the Origin check do that work.
- Validation is sync, and the token is claimed synchronously before the async store write, so two racing POSTs
  have one winner. Invalid input re-renders with blank password and does not consume. A store failure consumes;
  the next call offers a new page.
- `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, no
  script, `referrer-policy: no-referrer`, `autocomplete="off"`.
- All displayed values escaped. The server never logs a request body.

Shortcut accepted: no constant-time compare beyond what the 128-bit token gives; the viewer does the same on
loopback.

### D5. What an agent holding the fallback link can do

It cannot be stopped from POSTing if it has a shell or a web tool. What limits the damage:

- The offer tells it to hand the link to the user. URL elicitation keeps the link off the model when it works.
- A submission only stores. It sends nothing and answers nothing about correctness, so the page is no oracle.
- One accepted submission per link, and the re-offer limit of D6: at most two failed sign-ons per account and
  process through the page.
- The page is offered only when there is no entry or the entry was rejected, so it never replaces a working
  password, except in the window named under Risks.
- Nothing is prefilled from the URL, and the page names the host. If an agent posts a first profile with a host
  of its choosing, the next page shows that host, and a person sees where the password goes.
- An agent with a shell already has the user's rights. The page does not add to them.

### D6. Rejected password: one re-offer per account per process

The latch is untouched. At a latch refusal on a store profile, the hook offers a page if no re-offer page was
submitted for that account in this process. The count moves on submission, so an expired page costs nothing.

Totals for one process: first time, page → wrong → re-offer → wrong → stop: two failed sign-ons. Stale entry,
rejected → re-offer → wrong → stop: two. Then `credential set` or a restart.

Why two: `QMAXSIGN` is often 3 and unknown to the kit. **Owner's call if another number is wanted**; it is one
constant. Same limit as the latch, stated in the README: it is per process, not per box.

### D7. No profile: `list_servers` is the one trigger

A brand-new client calls `list_servers` first, or gets `unknown server "x". Available: none` from any tool, which
now adds that `list_servers` offers a setup page. That line is added in core only while the hook is
installed, so the sync load path and the standalone text do not change. `list_servers`'s handler is async and
owned by the server, so it can open the listener.

Host: from the skeleton in company-repo mode (the current folder has `policy.yaml` and `profiles/`, same detection
as `setup`), otherwise typed on the page. Name: `default`, or the partition's name in a company repo. With
profiles already present, nothing is offered: a typo must stay the existing error, per "A server name must exactly
match a listed profile".

Alternative: the page from any tool's unknown-server error. Rejected: that point is sync, and it would need
changes in both engines or a listener open from startup for every server, used by almost none.

`list_servers` stays `readOnlyHint`: the tool opens a loopback listener that refuses everything but a token and
writes nothing; only a person's submission writes.

### D8. Shared profile writing

Move out of `packages/server/src/setup-cli.ts` into `packages/server/src/profile-write.ts`: `fileFor`, `quote`,
`updated`, `real`, `id`, `within`, the `OWN` key set, company repo detection and partition listing, skeleton read and
its checks, the leak check, policy load, read-back check, store-first order, and the atomic 600/700 write. `setupCli`
keeps prompts, TTY and the test connection. `setup-selfcheck.ts` passing unchanged is the proof the move changed
nothing.

The page refuses any git work tree for the profile folder (`gitWorkTree`, already exported). This is stricter than
`setup`, which refuses only the company repo and helper profiles in a git work tree. `setup` is left as it is, since
its store profiles hold no secret either; the stricter rule applies only to the page's path.

### D9. Where the page cannot work

- Headless or remote: the link points at the server's own loopback, so it cannot work from elsewhere. No
  non-loopback bind and no option. The offer always names `credential set <profile>` or `setup`; the page expires
  unused. Someone who forwards the port on their own passes the Host check, and that is fine.
- Linux without Secret Service: the read fails as "cannot be read", so a store profile with no Secret Service is not
  offered a page at all. On first-time creation, the store write fails, the page shows the existing message pointing
  at `IBMI_PASSWORD_COMMAND`, nothing is written, and there is no in-memory fallback.
- `setup` and `credential` run as their own processes and install no hook.

### D10. Standalone engines

`packages/screen/src/index.ts` and `packages/source/src/index.ts` install no hook, so `signOnOnce` and the
unknown-server text behave as today. Neither package's source changes, so no "Modified by" line is due.

### D11. The spec's URL rules against a tokened loopback link

The MCP elicitation page's Safe URL Handling and Phishing sections were written for web servers with a login. How
this design reads each:

- No credentials or personal data in the URL: met. The link holds the loopback address and the token only; host and
  user appear on the page.
- HTTPS "for non-development environments" (a SHOULD): not met. A certificate for 127.0.0.1 would mean installing a
  CA, and the traffic stays on the machine.
- No URL "pre-authenticated to access a protected resource": **a reading, not clean compliance.** The token shows
  nothing and reads nothing back, and there is no session to take over. It does allow one write, for one named account:
  the store entry. D5 limits what a client holding it can do with that.
- "MUST verify the identity of the user who opens the URL": **not literally met.** A stdio server has no login and no
  cookie, and node exposes no peer identity for a TCP connection. The spec allows "a different mechanism"; ours is that
  the link works only on this machine, so a link sent to someone on another machine fails, which stops the phishing
  case the spec describes. Another user on a shared machine who gets the token is the remaining gap. Editing the URL
  gains nothing, since the page takes no values from it.

Rejected: a code shown in the client and typed on the page, because on the fallback path the model sees the code too.
**Owner's call:** recommend accepting this reading, since the alternatives are the terminal route only or a login this
server does not have.

### Answers to the brief's questions

| Question | Answer |
|---|---|
| Trigger with no profile; host | `list_servers` (D7). Host from a company skeleton, else typed on the page |
| Which layer owns what | Hook in core, page and elicitation in the server (D1) |
| Wait or fail | Fail with the offer; the retry succeeds (D2) |
| Headless, Linux without Secret Service | Terminal route named in every offer; no fallback storage (D9) |
| Rejected password | One automatic re-offer per account per process (D6) |
| Standalone packages | Unchanged (D10) |

### Owner decisions

- The tokened link against the spec's identity and pre-authenticated URL rules (D11): recommend accepting it.
- The re-offer limit (D6): recommend one re-offer, so two failed sign-ons per process.
- The demo wording (`demo-quickstart`): recommend allowing the page. The requirement used to say "never through
  Claude", and Claude now relays the offer, though never the password.
- A profile with no password source keeps its load error, since reaching the hook would mean changing the
  one-source rules. Recommend the skip: `.env.example` sets the store, so a copied example gets the page.

## Risks / Trade-offs

- [The VS Code extension may silently decline, or ignore an elicitation sent outside a request: the hook has no
  request context for `relatedRequestId`] → the link falls back after a decline or 10 s. Verified live only.
- [A later SDK drops `elicitInput` for `InputRequiredResult`, and the completion notification with it (D3)] → that
  upgrade changes the delivery call; the link and the retry stay. Nothing to do until the SDK moves.
- [The URL-handling MUSTs are met by a reading, not to the letter (D11)] → named as an owner decision.
- [The link's token can land in the run log through `settle("failed: ...")` and in MCP log notifications] → it holds
  no secret and dies on use or within 5 minutes. Whoever reads the run log as this user can read the profile folder.
  Accepted, no scrub.
- [Terminal `credential set` during a pending page leaves that link live for up to 5 minutes, so a late submission
  replaces a working password] → it costs one failed sign-on at worst and the user can run it again. Accepted.
- [Each server process has its own latch and its own re-offer count, so two MCP clients can spend more attempts] →
  same limit as the latch today. Stated on the page and in the README.
- [The model must call again after the user finishes, and could stop instead] → the error tells it to; a user can say
  "try again". The completion notification helps on clients that use it.
- [The listener binds a port during a pending page, including on a shared machine] → loopback only, token required;
  other local users cannot read the token unless it reached a shared log.

## Migration Plan

None. A profile that signs on today never reaches the hook. Rollback is reverting the branch; passwords already
stored and profiles already written stay valid for `setup` and the server.
