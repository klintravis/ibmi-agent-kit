## 1. Name parameter type

- [x] 1.1 `packages/guard/src/verbs.ts`: add `name` to the zod enum, `typed` and `EXPECTED`; exempt it from the free-text refusal
- [x] 1.2 Selfchecks: accepted and upper cased; quote, blank, paren, `&`, comma, `.`, `/`, 11 chars refused; in SQL outside quotes a name substitutes as an identifier (`public` -> `PUBLIC`); `${member}` in CL loads; string without `allowed` still refused; `allowed` with `name`; env rule denies a production library through `${lib}`

## 2. policy test

- [x] 2.1 `packages/server/src/policy-cli.ts`: always load verbs, print each refusal as an error, exit 1
- [x] 2.2 Selfcheck: a refused verb with no verb case exits 1; no verb folders unchanged

## 3. Docs and checks

- [x] 3.1 `docs/verbs.md` parameter types table and a checkout-style example; `packages/guard/README.md` and `packages/server/README.md` verb and policy-test lines
- [x] 3.2 `openspec validate verb-names --strict`, `npm run clean && npm run check`, docs-check, check-names
