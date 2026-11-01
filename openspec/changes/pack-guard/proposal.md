## Why

The "Packed contents" scenario of `config-bootstrap` (no `.claude/` or `templates/` in a published
package) was checked once by hand with `npm pack`. A later edit to a `files` list could ship the
skill unnoticed.

## What Changes

- `config-bootstrap`: the Packed contents scenario is checked on every CI run by a selfcheck in
  `packages/server` that reads each `packages/*/package.json` and fails when a `files` entry names or
  globs `.claude` or `templates`.
- No MCP tool added or changed.

## Out of Scope

Running `npm pack`, checking `.npmignore`, changing any package's `files` list.

## Impact

`packages/server/src/selfcheck.ts` only (it already reads repo-root files such as the skills).
