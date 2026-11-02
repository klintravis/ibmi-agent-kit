# @ibmi-agent-kit/screen

<!-- Modified by ibmi-agent-kit (2026): rewritten for the kit (install, profile folders, protected settings, mounting, the kit's execution guard hook). -->

The 5250 screen engine of ibmi-agent-kit, a hard fork of SH4RKKK's ibm-i-5250-mcp.

[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-3c873a?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](package.json)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-%5E1.19-6f42c1)](https://github.com/modelcontextprotocol/typescript-sdk)
[![IBM i](https://img.shields.io/badge/IBM%20i-5250-052fad?logo=ibm&logoColor=white)](https://www.ibm.com/docs/en/i)

An [MCP](https://modelcontextprotocol.io) server that lets AI tools like Claude Code drive IBM i 5250
green screens, the way the Playwright MCP server drives web pages. An agent opens a session, sees the
screen in a structured form, types into fields, presses keys, and reads the result back.

Interactive RPG is the code nobody can test automatically: it only exists when a display file is on
a screen and someone is typing into it. The source says what should happen and nothing says what did. This server hands an assistant the screen itself, so a program can be driven, watched
and pinned down with tests that run again after every compile.

It speaks TN5250 straight over a socket, negotiating BINARY, TERMINAL-TYPE, END-OF-RECORD and
NEW-ENVIRON the way a real terminal does. No emulator, no JVM, no SSH tunnel, nothing to install on
the IBM i, and pure Node on the client. If the telnet server is started, which it is by default, this
works.

## Example workflow

Say you ask: "open order entry on PROD, put the cursor on the fifth line and delete it."

1. `session_open(server: "PROD")` signs on and returns the first screen.
2. `screen_do(actions: ["type f1: 1", "key: Enter"])` walks the menus. Typing and the key travel as
   one exchange, because a 5250 holds typing locally and transmits nothing until an AID key.
3. Every action returns a snapshot: the literal screen, plus the format table with stable refs.

   ```
   screen: signature 8156d875c512
   size: 24x80   cursor: 18,7   keyboard: unlocked

       ....5....1....5....2....5....3....5....4....5....5....5....6....5....7....5....8
    1 |                                 Command Entry                         MYBOX1   |
    2 |                                                           Request level:   1   |
   17 | Type command, press Enter.                                                     |
   18 | ===>                                                                           |
   22 | F3=Exit   F4=Prompt   F9=Retrieve   F10=Include detailed messages              |

   fields: 1 input, 0 output
     [f1] 18,7    len 313  INPUT  ""
   ```

   Blank rows are dropped and real row numbers kept. The snapshot also lists the stack: the screens
   behind this one, nearest first, which is usually where F3 and F12 lead back to. A window is named
   on a line of its own, and is a screen of its own on the stack unless the host paints it straight
   over the screen below, with no clear and no save.
4. `screen_do(actions: ["cursor: 6,2", "key: F2"])` opens the confirmation window the program paints.
   The snapshot now carries the window's field, and the cursor is inside it.
5. `screen_do(actions: ["type f23: Y", "key: Enter"])` answers it.
6. `run_tests` replays the whole thing from a Markdown file after the next compile, so the answer
   stays answered.

## The live view

Set `IBMI_5250_VIEWER=true` to turn it on. `session_open` then starts a small page on your machine
and returns its URL. Open it once and watch the green screen repaint as the agent works, in the real
5250 colours, with the cursor and keyboard state.

![The live view, signed on to the main menu](docs/live-view.png)

The page is non interactive, so it is there to watch and nothing more. It runs on
`http://127.0.0.1:5250`, or whatever port you set in `IBMI_5250_VIEWER_PORT`, and the URL carries a
token that is new for every session.

Under the live screen are two sections, both closed until you open them.

### Screen stack

Still in development and being tested.

The screens behind the one on display, nearest first, like a stack of cards. Going back to one of
them takes the cards above it off the stack. Click a screen to see it as it was when it was last on
top, and click it again to hide it. The agent gets the same stack as text in every snapshot.

![The screen stack open, with the main menu picked](docs/screen-stack.png)

### History

Every screen before the one on display, one for each key the agent pressed, labelled with the key
and the time. Step back and forward with the arrows, or with the left and right arrow keys. Stepping
back holds the view while new screens arrive, and newest jumps to the latest again. A page opened
in the middle of a session still gets the whole history, up to the last 500 screens.

![The history open on the Programming menu](docs/history.png)

## Requirements

- Node 20 or newer on the client.
- A telnet server running on the IBM i, which is the default. Port 23 plain, or 992 for TLS.
- A user profile to sign on with. Make a dedicated one rather than using your own, because a green
  screen has a command line. See Security for more info.

## Install

This package is part of ibmi-agent-kit and is normally run through the kit's single server. See
the root `README.md` for install, profiles and the old-server migration. To run this engine
alone, build the repo (`npm ci && npm run check`) and register it:

```sh
claude mcp add ibmi-agent-kit-screen -- node <abs path>/packages/screen/dist/index.js
```

Put the profile in a `.env` in `~/.ibmi-agent-kit/` (create the folder). Restart Claude Code or run `/mcp`.

To mount this engine in another MCP server, import `@ibmi-agent-kit/screen/tools` and call
`register(mcp)`. The package root (`.`, `main`) is the standalone bootstrap above: importing it
starts a stdio server and installs process handlers.

## Configuration

All configuration lives in a profile file: `.env` for the default server, `.env.<name>` for a named one. The server looks in these folders, first match wins, and the first file found supplies the whole profile:

1. a folder you name in `IBMI_KIT_CONFIG_DIR` (or the older `IBMI_MCP_CONFIG_DIR`), set on the MCP server entry rather than in your shell
2. `~/.ibmi-agent-kit/`
3. `~/.ibm-i-servers/`

Connection and safety settings (host, user, password, ports, `IBMI_RESTRICTED`, `IBMI_ALLOWED_CL`, `IBMI_BLOCKED_CL`, `IBMI_5250_TLS_INSECURE`) come from the profile file only, never from the environment. See the root `README.md`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `IBMI_HOST` | yes | | IBM i host or IP |
| `IBMI_USER` | yes | | user profile |
| `IBMI_PASSWORD_STORE` | one of three | | `os`: the password is in the OS credential store (`ibmi-agent-kit credential set <profile>`) |
| `IBMI_PASSWORD_COMMAND` | one of three | | a helper command that prints the password; wins over the store. See the [server README](../server/README.md#passwords) |
| `IBMI_PASSWORD` | one of three | | plain password in the file; still works, with a warning. Ignored when a helper or the store is set |
| `IBMI_5250_DEVICE` | no | | virtual device to claim. Set a fixed name, or the host picks a `QPADEVxxxx` and the job attributes change between runs |
| `IBMI_5250_PORT` | no | `23` | `992` is telnet over TLS, `23` is plain |
| `IBMI_5250_CCSID` | no | `37` | EBCDIC code page. 273 German, 500 international, 1140 US with the euro sign |
| `IBMI_5250_TERMINAL` | no | `IBM-3477-FC` | terminal type to negotiate. `IBM-3179-2` for a box that refuses it, at 24x80 |
| `IBMI_5250_TLS_INSECURE` | no | `false` | accept any certificate on 992, self signed included |
| `IBMI_5250_VIEWER` | no | `false` | `true` starts the live view |
| `IBMI_5250_VIEWER_PORT` | no | `5250` | falls back to a free port when this one is busy |
| `IBMI_5250_CURLIB` | no | | typed into Current library at sign on |
| `IBMI_5250_PROGRAM` | no | | typed into Program/procedure at sign on |
| `IBMI_5250_MENU` | no | | typed into Menu at sign on |
| `IBMI_RESTRICTED` | no | `true` | `false` lifts the allowlist on what may be typed on a command line |
| `IBMI_ALLOWED_CL` | no | | extra verbs allowed on a command line in restricted mode |
| `IBMI_BLOCKED_CL` | no | | extra verbs refused when restricted mode is off |

The screen size is not a setting. The host picks it per screen with Clear Unit or Clear Unit
Alternate, so one session renders a 24x80 program at 24x80 and a 132 column one at 132.

### Restricted mode

Restricted mode is an allowlist, and it is on unless you set `IBMI_RESTRICTED=false`. Ten job scoped
commands can be typed on a command line and everything else is refused: `call`, `strdbg`, `enddbg`,
`chgcurlib`, `addlible`, `rmvlible`, `chglibl`, `dsplibl`, `edtlibl` and `signoff`. Put your own
start command in `IBMI_ALLOWED_CL`.

Turn it off and nothing is refused unless `IBMI_BLOCKED_CL` names it. There is no built in denylist,
because all the guard ever sees is text going into a field. Guessing at destructive verbs by prefix
would read as protection without being any.

See `assertCommandAllowed` in [src/guard.ts](src/guard.ts).

### Multiple servers

To work with more than one IBM i, add one env file per box next to `.env`. The name after `.env.` is
the server name.

```
.env          the default server
.env.PROD     a server named PROD
.env.DEV      a server named DEV
```

Each file holds the same variables for that box. You never type the server name yourself:
`session_open` takes an optional `server` argument and the assistant fills it in from what you say,
so "open a session on PROD" loads `.env.PROD`. Say nothing about a box and it uses `.env`.
`list_servers` is how the assistant learns which names exist.

## Tools

### Session

- **`session_open`**: connects, signs on and returns the first screen. Clears
  the device level screens in the way, including the "Attempt to Recover Interactive Job" one a
  previous dropped session leaves behind. `device`, `library`, `program` and `menu` override the
  profile for this session.
- **`session_close`**: signs off and releases the device. It presses its way out of an application
  first, using F12 to decline a screen that is asking something and F3 otherwise, both of which
  discard rather than commit.
- **`list_servers`**: the configured boxes, the sessions currently open, and the folders that were
  searched.

### Drive the screen

- **`screen_do`**: takes a list of actions, runs them in order, and returns only the final screen.
  Three action forms, the same ones a test file uses:

  | Action | Does |
  |---|---|
  | `type f1: ACME LTD` | put text in a field, by ref, by `row,col`, or by DDS name once known |
  | `key: Enter` | Enter, F1 to F24, PageUp, PageDown, Help, Clear, Print, Attn |
  | `cursor: 6,53` | move the cursor before the key |

  Cursor position is an argument to the key, which is why it has its own action: Help on a message
  line explains that message, Help anywhere else explains the field under it. Attn is the Attention
  key, which ACS usually puts on Esc: it runs the job's attention program, if the job has one. If an
  action fails the run stops there, and the error names the action and returns the screen as it
  stands.
- **`screen_snapshot`**: the current screen, changing nothing.

### Tests

- **`run_tests`**: replays the screen tests in `screen-tests/` and reports what passed. Opens its own
  session when none is given, and signs it off afterwards.

## Screen tests

Work in progress.

A test is a Markdown file in `screen-tests/`. Prose is ignored, so the file reads as a specification,
and the runner only looks at two fenced blocks: `5250-do` for the same action lines `screen_do` takes,
and `5250-expect` for checks.

````
```5250-do
type f1: call mylib/ordentr
key: Enter
```

```5250-expect
text: Order Entry
message: none
fields: 4 input
```
````

Run them in conversation with `run_tests`, or from a terminal:

```sh
node scripts/test.mjs                              # screen-tests/ on the default box
node scripts/test.mjs screen-tests MYBOX           # a folder, or one .md file
node scripts/test.mjs screen-tests MYBOX ordentr   # only tests whose file name matches
```

From a terminal it exits non zero when anything failed, so a build job can gate on it.

A `5250-expect` block asserts what the screen should look like. `text` and `not text` look for a
substring, `message` for a message id or `none`, `fields` for the number of input fields, and
`field f1` for one field's exact value. `cursor`, `keyboard` and `signature` check where the cursor
sits, whether the keyboard is locked, and whether the layout still matches.
[screen-tests/example.md](screen-tests/example.md) explains each one in full.

## Progress and logging

Tools narrate while they run, so a slow box looks slow rather than hung.

Live updates go out as MCP [progress notifications](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress)
when the client asks for them, which Claude Code does: `signing on as MYUSER`, `pressing F3 to reach
a screen with a command line`, `running test 2 of 7`. Clients that do not ask get the same messages
as info level log notifications instead. Everything is mirrored to stderr, because stdout is the
JSON-RPC channel and anything printed there would corrupt the protocol.

When nothing has happened for eight seconds a watchdog repeats the last step with the elapsed time
(`still working: pressing Enter (24s elapsed)`). A host that never answers times out after 15
seconds, and the error names the request it was last waiting on and returns the trail with timings.

## Security

This server signs on to your IBM i and types into whatever screen is in front of it. A green screen
has a command line, so anything driving it can type a CL command into a field and press Enter. Treat
it like any tool that can act on the box.

- **Least privilege first.** The server can do exactly what the profile in the env file can do, so
  give it one that reaches the program under test and nothing else. Add `lmtcpb(*yes)` and IBM i
  itself refuses almost everything typed on a command line. Restricted mode narrows it further.
- **Execution guard (kit server only).** Mounted in the kit server, `register(mcp, { guard })` gets
  the kit's execution guard. Before `screen_do` or `run_tests` sends a key that carries field data
  (not F3, F12, Clear or Attn), it decides whatever the command line holds then, typed or retrieved
  with F9, and F4 with a command on the line is always denied (its prompt's values go unseen);
  `session_open` reads the sign-on screen's System name, then has the program and library
  it would type decided before signing on. A deny sends nothing. Sign-on, recovery and sign-off
  keys the server sends itself are not decided. The standalone `ibmi-agent-kit-screen` bin has no
  guard. Restricted mode checks text as it is typed, so in the standalone bin a command retrieved
  with F9 is not checked; in the kit server it is checked again at the key, before the guard. See the [root README](../../README.md#safety).
- **Password masking.** Anything the screen hides while you type it stays hidden. Your password never
  shows up in what the assistant reads, in the live view, or in the logs.
- **The live view.** A non interactive page, served on 127.0.0.1 only, gated by a token that is new
  for every session.
- **Prompt injection.** Screen text, message lines and field values come back to the model as
  untrusted text. A program could paint text that tries to steer the assistant into typing something.
  The controls above limit what that could actually do.
- **Secrets.** Credentials live in `.env` and `.env.*`. Keep them readable only by you.

## Project layout

```
src/
  index.ts       tool registration
  session.ts     one 5250 session
  telnet.ts      TN5250 transport
  screen.ts      screen buffer and format table
  inbound.ts     records sent to the host
  codes.ts       5250 code tables
  guard.ts       the command line guard
  ebcdic.ts      EBCDIC tables
  snapshot.ts    the LLM facing view of a screen
  stack.ts       the screen stack
  render.ts      the live view page
  viewer.ts      the live view server
  config.ts      config discovery and the Profile loader
  testrun.ts     the screen test runner
  report.ts      progress and logging
  types.ts       shared types
  selfcheck.ts   npm run check, the test suite
scripts/
  test.mjs       screen tests from a terminal
test/fixtures/
  signon.bin     a sign on record, for the test suite
docs/            the live view screenshots
```

## Acknowledgements

Written from scratch, building on the work of others:

- **[green-screen-react](https://github.com/visionbridge-solutions/green-screen-react)** (MIT): the
  5250 code tables were adapted from `packages/proxy/src/tn5250/constants.ts`.
- **[tn5250](https://github.com/tn5250/tn5250)** (LGPL-2.1): read as reference for the data stream
  and the save screen and query replies. No code was copied.

Thanks to those teams and the wider IBM i community.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The 5250 code tables adapted from
green-screen-react keep their MIT license, which NOTICE carries in full. The dependencies keep their
own licenses (MIT and BSD-2-Clause), both of which are compatible with Apache-2.0.
