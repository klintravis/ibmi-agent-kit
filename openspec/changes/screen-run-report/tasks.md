## 1. note action

- [x] 1.1 `parseAction` accepts `note:`; `checkNotes` rejects a note with no key after it (an empty note fails in `parseAction`), and `applyActions` pairs the rest with their key; `applyActions` and `parseTest` call it before sending
- [x] 1.2 Step label is `<key>: <note>`; `screen_do` and `run_tests` descriptions say to add a note before each key and never to put typed values or passwords in one

## 2. Run report

- [x] 2.1 `Profile.reportDir` from `IBMI_5250_REPORT_DIR`, added to core's protected settings; `SCREEN_CSS` shared from `render.ts`
- [x] 2.2 `report-file.ts`: safe unique name, folder create, mode 0600, git work tree refusal, append per step, escaping, `shortcut:` comment
- [x] 2.3 `openSession` subscribes the report to `step` and `test`; `runTest` emits `test`; `session_open` and `session_close` name the path

## 3. Text and docs

- [x] 3.1 Correct "literal 24x80" in `session_open` and any stale wording in the screen and server READMEs
- [x] 3.2 `packages/screen/README.md` (settings table, "Run report" section, `note:`), core README and root README protected lists, screen-tests docs, `.env.example`

## 4. Checks

- [x] 4.1 Self-checks in `packages/screen/src/selfcheck.ts` (note, report, escaping, hidden field, 27x132, refusal, write failure, run_tests) and one revert check
- [x] 4.2 `openspec validate screen-run-report`, `check-names`, `docs-check`, `npm run clean && npm run check`
- [ ] 4.3 Live on PUB400: a 27x132 screen and a report file, run by the desk session
