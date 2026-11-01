The check lives in `packages/server/src/selfcheck.ts`, next to the demo/skill test that already
reads repo-root files via `EXAMPLES/..`; no selfcheck exists for "repo layout" as such, and the
server package depends on all the others. It reads `files` with `JSON.parse` and does not run
`npm pack`. An entry matches when it contains `.claude` or `templates`, or is a glob that starts
with `*` (which could pack them).
