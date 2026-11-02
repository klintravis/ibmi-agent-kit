## 1. Migration

- [x] 1.1 Set zod `^4.6.7` in guard, screen, server, source; refresh `package-lock.json`
- [x] 1.2 Give every one-argument `z.record` a `z.string()` key
- [x] 1.3 Update selfcheck assertions that quote zod 3 wording, keeping path and key checks

## 2. Review fixes

- [x] 2.1 Guard keeps its exact pin `zod 4.6.7`; screen, server, source keep a caret
- [x] 2.2 `parseYaml` refuses a `__proto__` map key and explicit non-plain tags (`!!set`, `!!timestamp`, `!!binary`, `!!omap`); selfcheck rows
- [x] 2.3 `issueLines` unfolds `invalid_key` and `invalid_union` so the repo's key messages print as on main; selfcheck rows
- [x] 2.4 JSON `__proto__` keys (MCP `args`, nested replay `lookups`) documented as dropped; selfcheck rows show no decision or parameter change, and top-level `lookups` still refuses it
- [x] 2.5 "Audit is clean" is a merge-time check run by hand, not CI

## 3. Verify

- [x] 3.1 `npm audit` and `npm audit --omit=dev` report 0
- [x] 3.2 `npm run clean && npm run check` exit 0; check-names clean
- [x] 3.3 Compare `tools/list` of origin/main and this branch; docs grep and docs-check
