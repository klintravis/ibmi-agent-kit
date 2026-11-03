# Proposal

## Why

Signing on today needs a terminal: `setup` or `credential set` must run in a real TTY, which is the
hardest step of the install for someone who only uses the kit through an MCP client. Owner ruling
2026-11-02: a user should sign on with no command line, first-time profile creation included. Form
elicitation cannot carry this: the MCP spec (2026-07-28) forbids form mode for passwords and requires
URL mode.

## What Changes

- When a sign-on finds no stored password for a store profile, the tool fails without sending anything,
  and the server offers a one-time page on 127.0.0.1. The user types the password there, the server
  stores it with the existing OS store code, and the next tool call signs on.
- When no profile exists at all, `list_servers` offers the same page, which also asks for the user ID,
  and for the host unless a company skeleton in the current folder supplies it. It writes the profile
  with the code `setup` uses, extracted rather than copied.
- The page is offered through URL elicitation when the client supports it. Otherwise, or after a decline
  or no answer, the tool's error prints the link. The tool call never waits for the user.
- After a rejected password the page is offered once more for that account in that process. The
  rejected-password record stays as it is. The page warns that a wrong password counts toward `QMAXSIGN`.
- `setup`, `credential set` and helper profiles stay as they are, and stay the route for headless and
  remote sessions.

No breaking change. A profile that signs on today behaves the same.

MCP tools, none added:

| Tool | Annotation (unchanged) | Change |
|---|---|---|
| `list_servers` | read-only | With no profile, its text carries the first-profile offer. The tool itself writes nothing; only a person submitting the page does |
| Every tool that signs on, such as `session_open`, `screen_do`, `compile_member`, `upload_source_member` (destructive) and `run_sql` (read-only) | unchanged | The failure text for a missing stored password or a rejected one can carry the page offer |

Out of scope:

- Any path that shows or asks for a password in the client, the model or chat. No form elicitation.
- Reaching the page from another machine: no bind other than 127.0.0.1, no option for one.
- Choosing a helper, a policy or a profile name on the page, or changing a working password there.
- A test connection from the page: the next tool call is the test.
- A profile with no password source at all keeps its load error. `.env.example` sets
  `IBMI_PASSWORD_STORE=os`, so a copied example already gets the page.
- A second company partition once a profile exists: that stays `setup`.
- The standalone `ibmi-agent-kit-screen` and `ibmi-agent-kit-source` servers: no page.
- New settings, environment variables, dependencies or page styling beyond plain HTML.

## Capabilities

### New Capabilities
- `signon-page`: the loopback page, its protections, how it is offered, and the first-profile path.

### Modified Capabilities
- `demo-quickstart`: the guided demo may create the profile on the page as well as through `setup`.

The `server-profiles` requirements still hold as written: a missing entry is still an error naming
`credential set` and `IBMI_PASSWORD_COMMAND`, a rejected password is still not resent, and an unknown
server name still fails naming what is available.

## Impact

- `packages/core/src/credential.ts`: a hook that `signOnOnce` calls; core still knows no MCP or HTTP.
- `packages/core/src/index.ts`: one more line in the unknown-server error, only when the hook is installed.
- `packages/server`: new `signon-page.ts` and `profile-write.ts` (extracted from `setup-cli.ts`);
  `server.ts` and `index.ts` wire them in and change the `list_servers` text.
- `packages/screen`, `packages/source`: no file changes expected. Errors raised before a send already
  pass through unchanged.
- Docs: `packages/server/README.md`, root `README.md` install path, `docs/demo.md`, the `demo` skill.
- No new dependency: `node:http`, `node:crypto` and MCP SDK 1.32.2, already installed.
