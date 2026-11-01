# Tasks

## 1. One host-change rule for both modes

- [ ] 1.1 In `packages/server/src/setup-cli.ts`, move the host-change check (design decision 1) to
  just after the host is known inside the prompt `try`: personal mode the answer of the host
  prompt, company-repo mode `skeleton.IBMI_HOST`; clear `keep` and print
  `IBMI_HOST <old> is replaced by <new>` (only when the old file had a host) before the user
  prompt; drop the repo branch's own copy. Verify: the existing test "setup in a company repo: a
  profile on another host never keeps its password" still passes unchanged.
- [ ] 1.2 In `packages/server/src/setup-selfcheck.ts`, add
  `test("setup: a profile on another host never keeps its password", ...)` modelled on the
  company-repo test at line 243, inside `isolated()`: write `.env.prod` with
  `IBMI_HOST=old.example.com`, `IBMI_USER=bob`, `IBMI_PASSWORD=${OLDPW}`; `seen.length = 0`; run
  `["prod"]` with keys `["new.example.com\r", "\r", "\r", "plainpw\r", "\r"]` (host, user kept,
  Enter at password rejected, password, policy left). The key list must be exact: one chunk short
  and `FakeTty` never ends, so the test hangs instead of failing. Assert: exit 0; output matches
  `/IBMI_HOST old\.example\.com is replaced by new\.example\.com\n/` and `/\npassword: \npassword: \n/`;
  no `Enter keeps the current one`; every `seen` env has `IBMI_PASSWORD !== OLDPW`; the file does
  not contain `OLDPW`; `resolveProfileEnv("prod")` gives host `new.example.com`, user `bob`,
  password `plainpw`. In the same test, a second profile with a password and no `IBMI_HOST`: the
  password prompt offers no default and no replaced line is printed. Verify: `npm run clean && npm run check`
  exits 0, and the new test fails against the unfixed `setup-cli.ts`.
- [ ] 1.3 Host unchanged keeps the password: in the existing test "setup: an update keeps other
  lines and comments, Enter keeps values, ..." (line 97), add
  `assert.match(r.out, /password \(Enter keeps the current one\): /)` and
  `assert.doesNotMatch(r.out, /is replaced by/)`; it already asserts the kept password
  `s3cret#2`. Verify: `npm run check` exits 0.
- [ ] 1.4 Docs: in `packages/server/README.md`, `setup` command step 2, change "Enter keeps the
  current one." to say Enter keeps it only when the host is unchanged; with a new host setup says
  the host is replaced and asks for a new password. Leave `docs/demo.md` lines 29 and 100 and the
  root `README.md` line 42 as they are (they rerun setup on the same host or do not mention
  Enter). Verify: the desk's docs check (`node <desk>/scripts/docs-check.mjs .`, run by
  `finish-worktree`) passes.

## 2. Integration

- [ ] 2.1 `npm run clean && npm run check` exits 0 and `node scripts/check-names.mjs` passes in the
  worktree.

## Workflow follow-up

- Archive the change after review and merge.
