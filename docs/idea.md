# The idea

Agents can already query Db2 for i. What they cannot do safely is *work* on IBM i: walk the
menus a person walks, run SQL and CL, change source, and prove the change on screen, without
one wrong command doing damage.

## Direction: execute and guard

- **Users sign on as themselves.** Every action runs in the person's own IBM i job, under
  their own authority. IBM i object authority is the real boundary; the kit never replaces it.
- **Knowledge lives in Claude skills.** What a company's libraries and workflows mean is
  written as skills, loaded by path from that company's private repo. The MCP holds none of it.
- **The MCP executes and guards.** It runs 5250, SQL and CL work, and catches dangerous
  mistakes before they run: a guard against accident, not against a determined user.

Public repo: the kit plus examples built against PUB400. A company's real policy lives in that
company's own private repo.

## Roadmap

Each step lands as an OpenSpec change under `openspec/changes/`.

1. `unified-kit`: one server, one profile loader, a SQL transport that can execute. *(this change)*
2. `execution-guard`: check SQL and CL before they run, in observe mode first.
3. `project-verbs`: named, reviewed operations a project defines on top of statements and commands.
4. `config-bootstrap`: create and validate a user's profiles and settings.
5. Company pilot, starting in observe mode: log what the guard would block, block nothing.

## Open questions

- Whether a company's security review approves SSH plus a bundled jar upload, or prefers an
  admin-run Mapepire daemon (the `daemon` transport).
- Whether the client supports elicitation, so the guard can ask a person to confirm.
- Whether PUB400's terms allow automated agent sessions, and at what rate.
