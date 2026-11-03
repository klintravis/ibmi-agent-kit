## Why

`session_open` over a session the host has closed overwrites the map entry without stopping the old
viewer. The old viewer keeps its port, so with a fixed `viewerPort` the new viewer falls back to an
ephemeral one. Separately, the reporter / try / catch `failResult` / finally `dispose` block is
repeated in six handlers in `packages/screen/src/tools.ts`.

## What Changes

- `session_open` drops a leftover entry (closing the session, stopping its viewer) once it has
  checked the session is not still open. A self-check fails without the fix.
- A small `tool()` wrapper in `tools.ts` takes over the repeated block for the handlers with nothing
  extra to do on failure (`screen_snapshot`, `list_servers`); the others keep their own block.

No behaviour change apart from the viewer fix. No MCP tool is added or changed; tool names, schemas,
descriptions, result text and error text are the same. No spec delta.

## Out of scope

Wrapping handlers whose catch or finally does extra work (`session_open`, `screen_do`,
`session_close`, `run_tests`): the wrapper would need options. Any change to the viewer itself.
