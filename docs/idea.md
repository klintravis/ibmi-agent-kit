# The idea

Agents can already query Db2 for i. What they cannot do is *work* on IBM i: walk the menus a
person walks, see what a green-screen program actually does, change source and prove the change
on screen. And every shop's IBM i is different — the libraries, the file names, the meaning of
field `CMCRLM` — so an agent that knows IBM i in general still knows nothing about *your* IBM i.

ibmi-agent-kit closes both gaps:

1. **Engines** — tools that act: 5250 screens (`packages/screen`) and source members
   (`packages/source`).
2. **Knowledge packs** — YAML that teaches the agent one enterprise, so adopting the kit is
   writing a pack, not writing code.

## Knowledge packs

A pack is a folder. Everything in it is reviewable text, so a pack is versioned, diffed and
code-reviewed like any other asset.

| Folder | Teaches | Example |
|---|---|---|
| `schema/` | Libraries, files, fields and what they mean in business terms | `CUSMST.CMCRLM` = customer credit limit, USD |
| `glossary/` | Business words mapped to objects | "credit hold" → `ORDHDR.OHHOLD = 'C'` |
| `workflows/` | Menu paths and programs for business tasks, runnable by an agent or as a test | "release a credit hold": main menu → 3 → 7 → … |
| `safety/` | Per-environment modes, allow-lists and step budgets | `prod`: explore only, 200 keys per session |

`pack init` drafts `schema/` from the system catalog (`QSYS2.SYSTABLES`, `QSYS2.SYSCOLUMNS`,
object text); people refine the meaning. Workflows an agent discovers while exploring are saved
as `discovered` and promoted by a person.

Public repo: the engines plus a sample pack built against PUB400. An enterprise's real pack
lives in that enterprise's own private repo.

## Safety model

The IBM i is the real guard: agents sign on with their own limited user profile (`*USE` on the
libraries in scope, no special authorities, `LMTCPB` where possible). The kit adds a second
layer — `explore` (read-only) and `test` modes, deny rules for known destructive screens and
commands, step budgets — but never claims to replace object authority.

## Phases

1. Import the engines with history; both build and pass their own checks. *(done)*
2. One MCP entry point exposing both engines.
3. Knowledge pack format v1 and the PUB400 sample pack.
4. `pack init` from the catalog.
5. Safety modes and session recording.
6. Workflow discovery → review → promotion.

Each phase lands as an OpenSpec change under `openspec/changes/`.

## Open questions

- SQL access: add a Db2 engine (Mapepire or ODBC), or pair with IBM's `ibmi-mcp-server`?
- Where packs are loaded from at runtime: a path, a git URL, or both.
- Whether PUB400's terms allow automated agent sessions, and at what rate.
