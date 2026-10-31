# ibmi-agent-kit

MCP toolkit for IBM i: 5250 screens (`packages/screen`), source members (`packages/source`),
and knowledge packs that teach an agent one enterprise. Intent: `docs/idea.md`.

- Every change starts as an OpenSpec change (`/opsx:propose`); project rules are in
  `openspec/config.yaml`.
- Public repo: no real enterprise data, hostnames or credentials, ever. `.env` and
  `packs/private/` are gitignored.
- `packages/screen` and `packages/source` are git subtrees of SH4RKKK's repos. Keep their
  `LICENSE`/`NOTICE`; pull upstream with
  `git subtree pull --prefix=packages/screen https://github.com/SH4RKKK/ibm-i-5250-mcp main`.
- Check before committing: `npm run check` (builds and runs both packages' self-checks).
