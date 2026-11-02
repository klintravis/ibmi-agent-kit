## Why

`npm audit` reports GHSA-mrhx-c7xc-m3w5 against zod below 4.6.6, which the four packages pin to 3.x. A company install needs `npm audit` clean, dev dependencies included. `@modelcontextprotocol/sdk` already accepts zod `^3.25 || ^4.0`.

## What Changes

- Move `zod` to `^4.6.7` in guard, screen, server and source; update `package-lock.json`.
- `z.record` takes a key schema in zod 4: add `z.string()` where it was one-argument (guard `offline.ts`, server `verbs.ts`).
- Selfcheck assertions that quote zod 3 error wording now quote zod 4 wording, as strict as before.
- No MCP tool is added, removed or changed in name, parameters or annotation. Policy, command, verb and policy-test files parse to the same results, with the same errors (the repo's own key messages are kept; wording of zod's own messages changes), except two refusals in `parseYaml` that keep zod 4 from loosening YAML and are stricter than before: a `__proto__` map key is refused anywhere (zod 4 drops such a record key unchecked; zod 3 refused a wrong-typed value under it and dropped a well-typed one), and every explicit YAML tag is refused except the core plain ones (`!!map`, `!!seq`, `!!str`, `!!int`, `!!float`, `!!bool`, `!!null`) and a bare `!`. That covers tags building a non-plain value (`!!set`, `!!timestamp`, `!!binary`, `!!omap`) and unknown tags (`!foo`), which yaml only warns about and which used to load with the tag dropped. JSON inputs do not pass `parseYaml` and differ in two places: a `__proto__` key in MCP tool `args` is now dropped, where zod 3 refused it when its value was an object (a scalar value was dropped before too); and a `__proto__` key inside the record maps of recorded replay `lookups` (`schemas`, `bases`) is dropped where zod 3 refused a wrong-typed value under it (the top level of `lookups` is strict and still refuses it). Dropping it cannot change a guard decision or supply a verb parameter (a selfcheck row shows `policy_check` results unchanged; a dropped replay answer makes the line skip as "never asked"). The advertised `tools/list` input schemas lose `additionalProperties: false` and gain integer `maximum` bounds and `propertyNames` on record parameters (zod 4's JSON Schema output); the server still ignores unknown arguments as before.

## Capabilities

### New Capabilities
- none

### Modified Capabilities
- `unified-server`: the installed dependency tree has no known advisories.

## Out of scope

Other dependency bumps, the npm package name (T-96), publishing, replacing deprecated zod 3 spellings (`z.ZodIssueCode`, `z.ZodTypeAny`, `.strict()`) that still work in zod 4.

## Impact

Four `package.json` files, `package-lock.json`, `packages/guard/src/offline.ts`, `packages/guard/src/commands.ts`, `packages/server/src/verbs.ts`, `packages/guard/src/selfcheck.ts`, `packages/server/src/verbs-selfcheck.ts`. Zod's own validation error wording changes (e.g. `Unrecognized key: "x"`); one edge: a YAML `.inf` in a verb parameter value is now refused by the schema (`Invalid input`) instead of by the type check, still at load.
