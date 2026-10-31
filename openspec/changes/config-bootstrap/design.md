# Design

## Context

After `execution-guard` and `project-verbs`, the kit has the policy format, `policy_check` (live
and offline), `ibmi-agent-kit policy test|replay`, the run log, and the verb format. Admins work
in a company's private repo with Claude Code, the kit MCP registered against their IBM i under
their own profile, and the built-in observe policy (reads allowed).

## Goals / Non-Goals

**Goals:** a first working, tested, observe-mode configuration in one session; a repeatable
maintenance run; nothing that needs a new MCP tool.

**Non-Goals:** automating enforcement; reading change-management products' internal databases.

## Decisions

### D1. Skill layout
`.claude/skills/ibmi-kit-config/SKILL.md` (when to use; the bootstrap and maintain procedures; the
safety rules), `references/discovery.md` (the queries, grouped, with release notes), and
`references/questions.md` (the question bank with recommended defaults). The description triggers
on "set up the kit for our company", "bootstrap the policy", "update our ibmi-agent-kit config".

### D2. Discovery queries (verify column names on the target release)
- System: `CURRENT SERVER`; `QSYS2.SYSTEM_STATUS_INFO`; `QSYS2.ASP_INFO` (IASPs); the RDB
  directory via `QSYS2.RDB_ENTRY_INFO` where available, else `WRKRDBDIRE` output is not used.
- Libraries: `QSYS2.OBJECT_STATISTICS('*ALLUSR', '*LIB')` (name, owner, text, creator, created);
  `QSYS2.SYSSCHEMAS` (long ↔ system names). `QSYS2.LIBRARY_INFO` only for a shortlist (slow).
- Identity: `QSYS2.USER_INFO` (group, supplemental groups, current library, job description,
  special authorities, status); `QSYS2.GROUP_PROFILE_ENTRIES`; `QSYS2.AUTHORIZATION_LIST_USER_INFO`.
- Change authority: `QSYS2.OBJECT_PRIVILEGES` for each candidate environment's libraries — which
  groups hold `*CHANGE`/`*ALL` — as evidence for roles × environments.
- Library lists: `QSYS2.JOB_DESCRIPTION_INFO` (`LIBRARY_LIST`) per job description users have.
- Change management: `QSYS2.SOFTWARE_PRODUCT_INFO`; libraries whose text names a vendor; their
  commands via `QSYS2.OBJECT_STATISTICS(lib, '*CMD')`; parameters via `QSYS2.COMMAND_INFO` where
  available (products may not register as licensed programs).

### D3. Inference rules
Prefix clustering on system library names (2–3 leading characters with ≥ 3 members); personal
convention from `CURRENT_LIBRARY_NAME` vs user name; roles from groups whose members hold change
authority on the same environment set; promote candidates from product commands with a level- or
environment-like parameter. Each inference is shown with its evidence before asking.

### D4. Generation
The nearest template is copied and filled — never referenced — so the company owns the file.
Tests: one allow and one deny per role × environment, plus the change-management command per
level. Profiles: `.env.<partition>` with host, user placeholder, transport, `IBMI_PARTITION`, and a
comment where the password goes. Files are written with the client's file tools on a branch.

### D5. Maintenance loop
Re-run D2, diff against the policy, summarise the run log since the last run (date recorded in the
company README), draft edits, `policy test`, `policy replay --since 14`, branch, summary for review.

## Risks / Trade-offs

- [Discovery views differ by release] → each query lists its minimum release; missing views are
  reported and the related question is asked directly instead.
- [Inference is wrong for an unusual shop] → every inference is a proposal with evidence and a
  question, never applied silently.
- [Admin's authority limits discovery] → stated up front; partial steps are reported.

## Migration Plan

Additive; no effect unless an admin runs the skill.
