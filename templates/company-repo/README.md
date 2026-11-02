# Company config repo (template)

What a company's private repo for its ibmi-agent-kit configuration looks like. The `ibmi-kit-config`
skill generates these files; an admin can also copy them by hand. This folder is not published.
Copy a policy from [../policies](../policies) to `policy.yaml` (with its tests), never reference it.

```
<company-repo>/
  README.md                      what this repo is, the date of the last maintenance run
  policy.yaml                    the execution policy (observe mode first)
  policy.tests.yaml              one allow and one deny per role x environment
  commands.yaml                  optional command file, listed under command_files in policy.yaml
                                 (vendor commands; see ../../examples/cm-product.yaml)
  profiles/.env.<partition>      profile skeleton per partition: host, user, transport, IBMI_PARTITION
  verbs/smoke.yaml               org-layer verbs, found beside policy.yaml; one smoke verb to start
  .github/workflows/policy.yml   CI: policy test on every push
  .mcp.json                      registers the kit server for everyone who opens Claude Code here
  .claude/settings.json          client permission rules (below)
  .claude/skills/<name>/SKILL.md your company's knowledge as Claude skills (Bring your existing skills)
```

Order of work: run the `ibmi-kit-config` bootstrap first, in an empty repo (it refuses a repo
that already holds other `.claude` content, a `package.json` or another project's sources), then
copy your skills in.

## Get started

You need Node 20 or later and a built checkout of
[ibmi-agent-kit](https://github.com/klintravis/ibmi-agent-kit) (its README, Install). `<kit>` is
that checkout's folder.

1. Clone this repo and `cd` into it.
2. Run setup in this folder, in a real terminal (it hides your password):

   ```sh
   node <kit>/packages/server/dist/index.js setup
   ```

   Once the kit is published, `npx ibmi-agent-kit setup` does the same. Setup lists this repo's
   partitions, asks your IBM i user and where your password comes from, copies the partition's
   settings from `profiles/`, points your profile at this repo's `policy.yaml`, and tests the
   connection. At the password source prompt press Enter for your OS credential store (then type
   the password, hidden), or type a helper command that prints it; the command is shown on screen,
   so it must hold no secret. Your choice goes only in your own profile folder
   (`~/.ibmi-agent-kit`), never in this repo, and a helper is refused if that folder is inside a
   git work tree. To rotate the password, run `credential set <profile>` (see the kit's
   [Passwords](https://github.com/klintravis/ibmi-agent-kit/blob/main/packages/server/README.md#passwords)). If it
   prints `set it to <folder>`, set `IBMI_KIT_HOME` to that folder for your user (Windows:
   `setx IBMI_KIT_HOME "<folder>"`; macOS and Linux: an `export` line in your shell profile) and
   open a new terminal.
3. Run `claude` in this folder.
4. Approve the `ibmi-agent-kit` server when Claude Code asks: this repo's `.mcp.json` registers it.
5. Optional: run `/demo` for a guided tour. It is a skill of the kit checkout, so run it from `<kit>`,
   not from this repo.

The policy path lives in each person's profile, not in this repo or `.mcp.json`, because only the
person whose credentials a policy guards can point a profile at it.

`.mcp.json` starts the kit from `IBMI_KIT_HOME`, so it holds no path of anyone's machine:

```json
{
  "mcpServers": {
    "ibmi-agent-kit": {
      "command": "node",
      "args": ["${IBMI_KIT_HOME}/packages/server/dist/index.js"],
      "env": { "IBMI_5250_VIEWER": "true" }
    }
  }
}
```

`IBMI_5250_VIEWER=true` turns on the live view: opening a 5250 session starts a small page on your
own machine, and the agent returns its URL, so you can watch the screen as it works. Set it to
`"false"` to turn it off for everyone.

## Profiles

Each `profiles/.env.<partition>` holds `IBMI_HOST`, `IBMI_USER` (a placeholder), the transport and
`IBMI_PARTITION`, with a comment that each person picks a password source at setup. **A password
or helper command is never written to this repo** (a helper in a repo would run on every
colleague's machine), and no `IBMI_KIT_POLICY` either (its path differs per clone). Don't copy the
skeleton: run setup (Get started), which copies every setting except the user, the password
settings and the policy path, and adds yours.

## Bring your existing skills

A skill lives at `.claude/skills/<name>/SKILL.md` in this repo and loads for everyone who runs
`claude` here. `.claude/settings.json` protects `verbs/**` from the agent; skills change by a
reviewed pull request like everything else here, so one user's guess does not become everyone's fact.
Sort each skill you already have:

| The skill holds | It becomes |
|---|---|
| Knowledge: naming conventions, coding standards, how the shop works | Stays a skill. |
| A repeatable CL or SQL procedure (a checkout, a cross-reference lookup, a compile procedure) | An org verb in `verbs/` ([docs/verbs.md](../../docs/verbs.md)); the skill shrinks to when and why to call `verb_run`. |
| A vendor command (a change-management product's `CMCHKOUT`, `CMPRM`) | An entry in `commands.yaml` (next section). |
| A standard a machine can check (no writes to production libraries, promotions only by QA) | A rule in `policy.yaml`, with a case in `policy.tests.yaml`. |

What the agent used to do by habit now goes through a kit tool, so the guard decides it:

| Old habit | Kit tool |
|---|---|
| Typed CL on a 5250 command line, ad-hoc SQL | `run_script`, `run_sql`, or a named procedure with `verb_run` |
| Read, edit and compile source | `read_source_member`, `upload_source_member`, `compile_member`, `search_source` |
| `ADDLIBLE` | `manage_library_list` |

In a skill, tell Claude to pass `server` (a name from `list_servers`) on every call, and to call
`policy_check` with the `verb` and its `args` before `verb_run`. Skeleton:

````markdown
---
name: cm-checkout
description: Check an object out of change management into a request. Use when the user asks to check out, lock or start work on an object in CMPRD.
---

# Check out an object

## When to use
The user names an object and a request number and wants to change it.

## How
1. `list_servers`, then use the partition's `server` name in every call below.
2. `policy_check` with `verb: cm-checkout` and `args: { req, object }`. Stop and report if any statement is denied.
3. `verb_run` with the same `verb` and `args`.

## Why
Checkout locks the object for the request; two people editing one object is the failure this avoids.
````

## Vendor commands and product libraries

List a change-management or cross-reference product's commands in `commands.yaml` (listed under
`command_files`); [examples/cm-product.yaml](../../examples/cm-product.yaml) is the shape, and
[docs/policy.md](../../docs/policy.md#command-tables) has every key.

- List every parameter that names a library or object in `params`. A parameter not listed is not
  interpreted, so a library it names is not decided. `policy test` (on stderr) and `policy_check`
  warn when a command is given a parameter its entry does not name; a keyword listed only in
  `positional` counts as considered.
- Read-only lookups and refresh or write commands are different classes. Give the lookups
  `class: read` and the refreshes and checkouts `class: write` (or your own class), so a rule can
  allow one and not the other.
- The guard decides a vendor command per library or object its `params` name, so a rule's `env:`
  matches those, not the command's own `library:`. A command with no such parameter (a lookup by
  request number) has no environment: give it a class of its own (`cm_lookup`) and a rule without
  `env:`. A rule with `env:` never matches it, and it is denied. `CMCHKOUT` below is decided
  against the libraries in `OBJ` and `SRCLIB`, so the write rule names the environment of the
  libraries people check out of.

```yaml
# commands.yaml (invented product)
commands:
  WRKCMREQ: { class: cm_lookup, library: CMPRD, positional: [REQ] }
  CMCHKOUT: { class: write, library: CMPRD, positional: [REQ, OBJ, SRCLIB], params: { OBJ: object, SRCLIB: library } }
  XRFREFRSH: { class: write, library: XREF, positional: [LIB], params: { LIB: library } }
```

```yaml
# policy.yaml
environments:
  - { name: products, libraries: [CMPRD, XREF] }
  - { name: devlibs, match: ["DV*"] }
roles:
  - { name: dev, groups: [GRPDEV] }
rules:
  - { classes: [cm_lookup], decision: allow }
  - { env: products, classes: [liblist, read], decision: allow }
  - { roles: [dev], env: [devlibs, products], classes: [write], decision: confirm }
```

Cases for `policy.tests.yaml` that prove it (each `as` is `{ user: JDOE, groups: [GRPDEV] }`):

```yaml
- { name: lookup, as: { user: JDOE, groups: [GRPDEV] }, script: "CL: CMPRD/WRKCMREQ 123", expect: allow }
- { name: checkout asks, as: { user: JDOE, groups: [GRPDEV] }, script: "CL: CMPRD/CMCHKOUT REQ(1) OBJ(DVLIB/PGM1) SRCLIB(DVLIB)", expect: confirm }
- { name: unqualified refused, as: { user: JDOE, groups: [GRPDEV] }, script: "CL: CMCHKOUT REQ(1) OBJ(DVLIB/PGM1)", expect: deny }
```

## Denied even in observe mode

`mode: observe` lets a denied statement run, except `danger` operations, unqualified changes and a
partition conflict, which are denied in every mode; see [docs/policy.md](../../docs/policy.md#rules).
The cases a vendor setup meets most:

- `SBMJOB` wrapping a command: the job runs elsewhere, unseen. Call the command directly, or wrap the work in a verb.
- `QSH` and `STRQSH` (Qshell): opaque to the guard. Use the CL or SQL it would run, or a verb.
- A CL variable (`&VAR`) in a parameter: its value is known only at run time. Write the value, or pass it as a verb argument.
- An unqualified vendor command whose entry has a `library:`. Qualify it to its product library (`CMPRD/CMCHKOUT`).
- A qualified command not in the table. Add it to `commands.yaml`, or call it from a verb once it is classified.

## Policy and tests

Start in `mode: observe`: everything is decided and logged, nothing extra is blocked. Check:

```
ibmi-agent-kit policy test policy.yaml policy.tests.yaml
```

Read the run log, then `ibmi-agent-kit policy replay` a candidate edit before changing a rule, and
move partitions to `enforce` one at a time. See [docs/policy.md](../../docs/policy.md).

## CI

`.github/workflows/policy.yml` runs `policy test` on every push and pull request, so a policy edit
that breaks its tests cannot merge.

```yaml
name: policy
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/checkout@v4
        with:
          repository: klintravis/ibmi-agent-kit
          ref: main            # pin a tag or commit SHA
          path: kit
      - run: npm ci && npm run check
        working-directory: kit
      - run: node kit/packages/server/dist/index.js policy test policy.yaml policy.tests.yaml
```

Nothing is published to npm, so CI builds the kit from its repo (the install steps in the root README).

## Client permission rules

Keep the agent from editing the policy, profiles and verbs. In `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Read(~/.ibmi-agent-kit/runs/**)"],
    "deny": [
      "Edit(policy.yaml)", "Edit(policy.tests.yaml)", "Edit(commands.yaml)",
      "Edit(profiles/**)", "Edit(verbs/**)",
      "Read(~/.ibmi-agent-kit/*.*)", "Read(~/.ibm-i-servers/**)"
    ]
  }
}
```

The run log in `~/.ibmi-agent-kit/runs/` stays readable, for the maintain step's run-log summary;
the profiles and passwords (`.env`, `.env.<name>`) stay denied, there and in `~/.ibm-i-servers`.
Deny wins over allow in Claude Code, so the deny matches only top-level names containing a dot,
never `runs`. Limit: a top-level name without a dot, or a subfolder other than `runs`, is not
denied; the kit keeps `.env*` profiles, `runs/` and the user `verbs/` layer there, so `runs/` and
`verbs/` are readable. A profile folder set with `IBMI_KIT_CONFIG_DIR` needs its own deny rule.

The `ibmi-kit-config` skill works on a branch and an admin edits through it deliberately, so lift
these rules for that session, or let the admin make the edit.

## Maintenance

Note the date of each run here: the next run summarises the run log since then.

Last maintenance run: (none yet)
