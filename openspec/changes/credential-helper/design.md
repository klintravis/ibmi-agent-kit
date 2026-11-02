# Design

## Context

See `proposal.md` for why. Findings from the code at `f47ca0a`:

**Password reads.** `resolveProfileEnv` (core) is synchronous and is also used for non-secret reads
(`server.ts:47`, `guarded.ts:404`, `verbs.ts:368`). `loadProfile` (source and screen) requires
`IBMI_PASSWORD`. The password is read at three send points: `source/src/transport.ts:48`,
`source/src/sshMapepire.ts:90`, `screen/src/session.ts:302`. It is read as a string for the run log at
`server/src/guarded.ts:441` and `:552`.

**What a sign-on failure does today.**

- No inner loop re-sends a rejected password. ssh2 sends it once per connect. `Session.establish` throws
  on a rejected sign-on (its 3-pass loop re-signs only after recovery option 90, password accepted).
  `MapepireTransport.live()` throws.
- A failed connect leaves no job, so every next call signs on again. `readBox` (`guarded.ts`) catches a
  failed identity query, does not cache, and the tool's own query then calls `live()`. **One guarded
  call sends a bad password at least twice, two calls reach four**, past a `QMAXSIGN` of 3.
- `session_open` opens a new `Session` per call, and `run_tests` signs on once per suite, not per test.
  An agent's own retry adds to all of these.

So making the helper run once is not enough. The latch below is the new part, and it fixes the
`readBox` double send without touching `readBox`.

## Goals / Non-Goals

**Goals:** no plain password written by the kit; helper and OS store both work; one send of a rejected
password per process; existing plain profiles keep working.

**Non-Goals:**

- A latch across processes. Writing it to disk would store secret-derived data. Two MCP hosts plus
  `setup` can still reach 3 attempts between them.
- Refusing plain profiles by policy. Follow-up if the owner wants it (see Open Questions).
- Reading a secret before a first connect. The run log has no value to mask until a sign-on happened.
  CL password parameters are redacted anyway, and `readBox` nearly always connects first.

## Decisions

### One choke point in core

New `packages/core/src/credential.ts`, used at all three send points:

```ts
signOnOnce(profile, send: (secret: string) => Promise<T>, isRejected: (e: unknown) => boolean): Promise<T>
lastSecret(host, user): string | undefined   // run log and setup scrub; never fetches
passwordSource(env): { password?, passwordCommand?, passwordStore?, profileFile? }  // used by both loadProfile
```

`Profile.password` becomes optional and the three other fields are added, so about 60 test fixtures with
`password: "..."` keep compiling and exercise the plain path. `signOnOnce`, per key `USER@host`, on a
promise chain: fetch once, remember as `lastSecret`, refuse when equal to the rejected value, call
`send`, clear on success, record when `isRejected(e)`, rethrow.

Alternative rejected: a helper that only runs a command. It leaves the double send (see Context).

### No cache for sending

Every send fetches, including the 5250 recovery re-sign-on inside `establish`. One fetch per password on
the wire is the simplest rule to state and test, and a rotated password is picked up with no restart.
Only the last value is kept, for masking and latch comparison: the same in-memory exposure as today's
plain `profile.password`. A long-lived backend would otherwise hold a stale password and burn an attempt.

### The latch

The refusal fetches once and compares, so correcting the store or helper clears it with no restart. The
error also says a restart retries the same one, as a human escape: the 5250 "still on the sign on
screen" branch could misfire on a slow screen. For the daemon, only auth-shaped errors
(`Unexpected server response: 401`, or `authentication` as a whole word) latch, matched on the raw message with no host
removal (removing it mangled real errors whose text overlaps the host, e.g. host `server`); `authentication` inside a
host name (`authentication-gw.corp`, `gw.authentication.corp`) does not match, only a single-label host named exactly `authentication` can; anything else stays unlatched, which is today's
behaviour, so an unconfirmed text is safe either way. `ws` reports `Unexpected server response: 401` and mapepire-js passes it on.
Whether the daemon answers 401 is not verified against a live box.

The chain holds a sign-on until the previous one ends. A hung connect delays other sign-ons for that
user and host until its own timeout. Accepted: wrong-password safety beats speed here.

### A direct store key, not a generated helper line

`IBMI_PASSWORD_STORE=os`, read in-process with a lazy `import("@napi-rs/keyring")`, over the suggested
`IBMI_PASSWORD_COMMAND=<node> <kit dist> credential get <profile>`.

- Absolute node and dist paths rot when the checkout moves, and the kit installs from a checkout.
- `C:\Program Files\nodejs\node.exe` needs quoting, and a process per connect costs time.
- A `STORE=os` line executes nothing, so it is safe in any folder, including a git work tree.
- No `credential get` means no kit command that prints the password to stdout for an agent with a shell.

### Store entry keyed by `USER@host`, not profile name

An edited `IBMI_HOST` then finds no entry instead of sending the old password to a new box, which holds
the "same host" invariant at runtime. Two profiles for one box and user share a password, which is true
on IBM i.

### Linux pins the Secret Service

`new AsyncEntry(service, account, { linux: { store: 'secret-service' } })`. The default falls back
silently to kernel keyutils, which is lost at restart: it would seem to work until a reboot. Pinned, it
throws when unavailable (`index.d.ts`, `LinuxEntryOptions`), which gives the required clear error.

### Helper execution

`execFile` with no shell, `cwd: homedir()`, `stdio: ['ignore','pipe','ignore']`, `windowsHide`, 30 s
timeout, 64 KiB `maxBuffer`, UTF-8.

- `cwd: homedir()` is an addition. Probed on Windows: a bare name resolved from the spawn cwd
  (`execFile("ikitplanted")` ran the planted file with cwd set to it, ENOENT with cwd home), and an MCP
  server's cwd is the host's project, possibly an untrusted repo.
- Stderr is dropped because a helper may echo the secret there.
- Only one trailing line ending is removed, since a password can end in a space. A BOM is removed
  because a PowerShell pipeline can add one.
- `.cmd`, `.bat` and `.ps1` are refused before the spawn. Also wrap the spawn in try/catch: Node 22 threw
  `EINVAL` synchronously on a `.cmd` path in a probe. Ensure the timeout still ends the call when a
  grandchild holds the pipe open.

dotenv corrupts a double-quoted value holding `\n`: `K="C:\new\x.exe" -File y.ps1` becomes a newline and
loses its quotes. A value starting with a quoted path, or holding `#`, must be wrapped whole in single
quotes. `setup`'s `quote()` already does that; the docs say it for hand edits. A value that comes back
with a line break gets a clear error from the splitter.

### Git work tree refusal and the trust boundary

Anyone who can write the profile file, or an MCP registration (which runs a command and can set
`IBMI_KIT_CONFIG_DIR`), already has code execution as the user. So the loader does not defend against
those. The new risk is a helper line in a repo that is reviewed as data and pulled by everyone. Hence:
`setup` never copies one from a skeleton, and the loader refuses a helper in a profile whose real path
has `.git` above it. `resolveProfileEnv` records the path in `IBMI_KIT_PROFILE_FILE`, assigned after the
file overlay so nothing can spoof it. The check is at fetch time, so non-secret reads are unaffected.
Limit: a home folder that is a dotfiles git repo is refused too; the error points at the store or another
folder.

### Plain line stays, warned

Precedence `COMMAND > STORE > PASSWORD`, no fallback: falling back after a helper failure would send a
stale password and burn an attempt. See Open Questions for the ruling.

### setup

One prompt. Enter is the OS store then a hidden password prompt. Any other text is a helper command.
With a current helper on the same host and user: Enter keeps it and `os` switches. Keeping an old plain
line migrates it to the store. `IBMI_PASSWORD_COMMAND` and `IBMI_PASSWORD_STORE` join `OWN`. The same-host
rule also requires the same user, since a password belongs to a user and a wrong one costs an attempt.

Two code details: `updated()` must be able to delete lines, and removed keys must also leave `want`, or
the read-back drift check would refuse every migration. The scrub adds `lastSecret` to what it masks.

### Windows Credential Manager example (for the docs)

```powershell
# C:\tools\get-ibmi-password.ps1 (Get-StoredCredential is from the CredentialManager module)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$c = Get-StoredCredential -Target 'ibmi/dev'
if (-not $c) { exit 3 }
[Console]::Out.Write($c.GetNetworkCredential().Password)
```

```
IBMI_PASSWORD_COMMAND=powershell -NoProfile -File "C:\tools\get-ibmi-password.ps1"
```

The encoding line matters: PowerShell 5.1 pipes in the OEM code page, and a mangled non-ASCII password
is a wrong password, so an attempt is burnt. Under constrained language mode a P/Invoke script is blocked;
use the OS store there. The docs say to run the script by hand first.

## Risks / Trade-offs

- **Latch is in-process.** See Non-Goals. Docs state that a wrong password can still cost one attempt per
  server process and per `setup` run.
- **Native module on an unusual platform.** Lazily imported and wrapped, so only store users feel it, with
  a pointer to the helper. The lockfile must keep all 12 platform optional entries; the selfcheck that
  loads the module on all CI legs guards this.
- **Licence.** `@napi-rs/keyring` is MIT, but its Linux binaries statically link libdbus
  (`AFL-2.1 OR GPL-2.0-or-later`). Flagged to the owner.
- **`npm audit`.** The keyring tree adds 0 advisories. `main` itself reports `zod <4.6.6` until the `zod4`
  branch merges.
- **Not verified here.** Linux and macOS store behaviour, Windows entry format under domain policy, daemon
  auth text, macOS keychain prompts blocking a headless read, a custom sign-on screen that returns a
  different record format on a bad password (would read as success, and is the same today).

## Open Questions

Owner, none blocks the work: keep `IBMI_PASSWORD` profiles working with a warning (assumed here), or
reject them; and whether a policy-level refusal of plain profiles is wanted as a follow-up.
