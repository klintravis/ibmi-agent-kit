## Why

`npm audit` reports GHSA-mrhx-c7xc-m3w5 against zod below 4.6.6, which the four packages pin to 3.x. A company install needs `npm audit` clean, dev dependencies included. `@modelcontextprotocol/sdk` already accepts zod `^3.25 || ^4.0`.

## What Changes

- Move `zod` to `^4.6.7` in guard, screen, server and source; update `package-lock.json`.
- `z.record` takes a key schema in zod 4: add `z.string()` where it was one-argument (guard `offline.ts`, server `verbs.ts`).
- Selfcheck assertions that quote zod 3 error wording now quote zod 4 wording, as strict as before.
- No MCP tool is added, removed or changed in name, parameters or annotation. Policy, command and verb files parse to the same results. The advertised `tools/list` input schemas lose `additionalProperties: false` and gain integer `maximum` bounds and `propertyNames` on record parameters (zod 4's JSON Schema output); the server still ignores unknown arguments as before.

## Capabilities

### New Capabilities
- none

### Modified Capabilities
- `unified-server`: the installed dependency tree has no known advisories.

## Out of scope

Other dependency bumps, the npm package name (T-96), publishing, replacing deprecated zod 3 spellings (`z.ZodIssueCode`, `z.ZodTypeAny`, `.strict()`) that still work in zod 4.

## Impact

Four `package.json` files, `package-lock.json`, `packages/guard/src/offline.ts`, `packages/server/src/verbs.ts`, `packages/guard/src/selfcheck.ts`. Zod's own validation error wording changes (e.g. `Unrecognized key: "x"`); one edge: a YAML `.inf` in a verb parameter value is now refused by the schema (`Invalid input`) instead of by the type check, still at load.
