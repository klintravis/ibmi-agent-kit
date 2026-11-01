# Proposal

## Why

The first live run stalled on the things around the kit, not the kit itself: the user had to find
and edit a hidden profile file by hand, the `/demo` skill went looking for `docs/demo.md` and the kit
path at every step, a rejected project MCP-server approval hid the server without a word, and the
config bootstrap nearly ran in the wrong folder because the VS Code panel starts in the workspace
root. A first run should need one terminal command for the profile and no guessing about paths.

## What Changes

- New CLI subcommand `ibmi-agent-kit setup [name]` (packages/server): asks host and user (current
  values as defaults), reads the password at a hidden terminal prompt, optionally sets
  `IBMI_KIT_POLICY` to an absolute path, writes or updates `<config dir>/.env[.<name>]` atomically
  (keeping every other line and comment, mode 0600 on POSIX), then loads the profile back from the
  file, checks it is listed, connects with the kit's SQL transport and prints one OK/failed line.
  Refuses a bad name, a non-terminal stdin, and a value that cannot be written safely in `.env`
  syntax. The password never appears in argv, output or error text.
- `/demo` skill and `docs/demo.md`: the user runs `setup <name>` in their own terminal; the kit path
  comes from `claude mcp get ibmi-agent-kit`; a pending, rejected or disabled project server is
  explained with the documented way to re-enable it; Part D starts `claude` from a terminal in the
  new folder; a note on which settings may go in the MCP registration's env (non-protected, e.g.
  `IBMI_5250_VIEWER`) and which only in the profile file (protected).
- `ibmi-kit-config` skill, Bootstrap step 1: refuse a folder that is not an empty company repo and
  say why (allowed: `.git`, `README*`, `LICENSE*`, `.gitignore`, plus the session's own `.mcp.json`
  and `.claude/skills/`, `.claude/settings.local.json`); a folder with the kit's own `policy.yaml`
  still goes to Maintain.
- READMEs (root and packages/server) document `setup`.

### MCP tools added or changed

None. `setup` is a CLI subcommand of the server binary, like `policy`; it registers no tool.

## Out of scope

- Any flag or option beyond `setup [name]` (no `--host`, no non-interactive mode, no password from
  a file or environment variable).
- Editing other profile settings (ports, transport, partition, read-only and so on) or deleting a
  profile; those stay hand edits.
- Copying settings from a same-named profile in a later folder (`~/.ibm-i-servers`); `setup` warns
  that its file takes precedence.
- Storing the password anywhere but the profile file (no OS keychain).
- Changing which settings are protected.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `server-profiles`: adds the `setup` command that creates or updates a profile file and tests it.
- `demo-quickstart`: the guided demo uses `setup`, finds the kit from the registered server, explains
  a hidden project server, and documents registration env versus profile file.
- `config-bootstrap`: the bootstrap refuses a folder that is not an empty company repo.

## Impact

- `packages/server`: new `src/setup-cli.ts`, dispatch in `src/index.ts`, new `src/setup-selfcheck.ts`
  loaded by `src/selfcheck.ts`, README.
- `packages/core`: `serverName` and `parseProfile` exported (the loader's own name rules and parser).
- `packages/source`: `loadProfile` re-exported from `src/tools.ts` (forked file, modification line
  updated).
- `.claude/skills/demo/SKILL.md`, `.claude/skills/ibmi-kit-config/SKILL.md`, `docs/demo.md`,
  root `README.md`.
- No new dependency.
