## 1. Quiet reporter

- [x] 1.1 Set `check` to `npm run build && node --test --test-reporter=dot dist/selfcheck.js` in core, guard, screen, server, source
- [x] 1.2 Raise `engines.node` to `>=18.15` in the five packages and the `config.yaml` context line

## 2. Verify

- [x] 2.1 `npm run clean && npm run check` passes with a few KB of output; check-names clean
