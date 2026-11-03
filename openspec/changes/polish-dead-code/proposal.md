## Why

An audit found small duplicates and dead code in the server and screen packages: five copies of the
error-to-text helper, `serverArg` and `key` defined twice, an unread `from` field, and a helper
used only by a self-check.

## What Changes

- `packages/server/src`: `credential-cli.ts`, `verbs.ts`, `policy-cli.ts` and `index.ts` use the
  `message` helper from `profile-write.ts` instead of their own copies.
- `serverArg` and `key` are defined once in `verbs.ts` and imported by `guarded.ts`.
- `readSkeleton` no longer returns its unread `from` field.
- `attrName` moves from `packages/screen/src/codes.ts` to the screen self-check, its only user.

No behaviour change. No MCP tool is added or changed; tool names, schemas and result text are the
same. No spec delta.

## Out of scope

`connect()` in `packages/source/src/mapepire.ts`: the source self-check calls it, so removing it
needs a test change. Any change to a profile, policy or CLI field.
