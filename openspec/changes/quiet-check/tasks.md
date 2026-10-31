## 1. Quiet reporter

- [x] 1.1 Set `check` to `npm run build && node --test --test-reporter=dot dist/selfcheck.js` in core, guard, screen, server, source
- [x] 1.2 Raise `engines.node` to `>=20` in the five packages and the `config.yaml` context line

## 2. Verify

- [x] 2.1 `npm run clean && npm run check` passes with a few KB of output; check-names clean

## 3. Review fixes

- [x] 3.1 unified-server delta: Node 20 requirement
- [x] 3.2 Refresh package-lock.json engines
- [x] 3.3 Selfcheck: a failing test's name and message reach the dot reporter output
- [x] 3.4 Proposal Impact lists the READMEs

## 4. Node 20 floor

- [x] 4.1 Drop Node 18: engines `>=20`, CI matrix 20/22, READMEs, config.yaml, specs
- [x] 4.2 Proposal and design record the ruling and the CI evidence
