## 1. Migration

- [x] 1.1 Set zod `^4.6.7` in guard, screen, server, source; refresh `package-lock.json`
- [x] 1.2 Give every one-argument `z.record` a `z.string()` key
- [x] 1.3 Update selfcheck assertions that quote zod 3 wording, keeping path and key checks

## 2. Verify

- [x] 2.1 `npm audit` and `npm audit --omit=dev` report 0
- [x] 2.2 `npm run clean && npm run check` exit 0; check-names clean
- [x] 2.3 Compare `tools/list` of origin/main and this branch; docs grep and docs-check
