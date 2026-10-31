# ibmi-agent-kit

An MCP toolkit that lets AI agents work on IBM i the way a person does: drive 5250 green
screens, read and compile source, and learn an enterprise's data structures and business
workflows from a **knowledge pack** — plain YAML a team can write and review.

> Status: early. The two engines are imported; knowledge packs are being designed.

## What's inside

| Package | What it does | Origin |
|---|---|---|
| `packages/screen` | Drives 5250 sessions over TN5250: structured screens, fields, keys, live viewer, Markdown screen tests | imported from SH4RKKK/ibm-i-5250-mcp |
| `packages/source` | Reads, searches, edits and compiles source members over SSH | imported from SH4RKKK/ibm-i-source-mcp |

Planned: a single MCP entry point over both, and knowledge packs (`schema`, `glossary`,
`workflows`, `safety`) that teach the agent one enterprise. See `docs/idea.md`.

## Built on

The screen and source engines are the work of SH4RKKK, imported with their full git history
under the Apache License 2.0: https://github.com/SH4RKKK/ibm-i-5250-mcp and
https://github.com/SH4RKKK/ibm-i-source-mcp. Their `LICENSE` and `NOTICE` files are kept in
each package. Changes made here are listed in each package's history.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
