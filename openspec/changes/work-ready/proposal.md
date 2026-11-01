## Why

A company adopts the kit with about 15 existing Claude skills (change-management checkout,
cross-reference lookups, compile procedure, naming and coding standards). The docs carry dev-log text
(roadmap, live-test provenance, old-server migration) a company user should not read, and say nothing
about where skills go or how vendor commands, product libraries and the always-denied cases are set up.

## What Changes

- Prune: remove the README Roadmap and "Moving from the old servers", `docs/idea.md` (references
  fixed), live-test provenance in the README, `docs/policy.md` and the guard README (one user-relevant
  "unverified on a live system" line stays in `docs/policy.md` Limits), the screen README migration
  note, and `packages/screen/scripts/smoke.mjs`. The README Policy section shrinks to a pointer.
- Add to `templates/company-repo/README.md`: `.claude/skills/`, "Bring your existing skills", vendor
  command and product-library guidance, a "Denied even in observe mode" list, and the order of work.
- Add to `docs/policy.md`: the `params` rule for library-naming parameters and one sample run-log line.
- The root README states the direction in the intro: users sign on as themselves, knowledge lives in
  company skills, the MCP executes and guards.

No MCP tool is added or changed. No requirement of the `documentation` spec changes, so there is no
spec delta.

## Out of scope

Any `.ts` file; `docs/verbs.md`, `packages/server/README.md` and `packages/guard/src` (another change
owns them); behaviour of the core self-check; the `ibmi-kit-config` skill.
