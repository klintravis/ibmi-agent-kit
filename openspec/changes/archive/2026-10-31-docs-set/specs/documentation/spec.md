## ADDED Requirements

### Requirement: Documentation set
Every package SHALL have a `README.md`, the root `README.md` SHALL list every registered MCP tool in
a Tools table, and the policy file SHALL be documented in `docs/policy.md`.

#### Scenario: Docs gate
- **WHEN** `docs-check` runs on the repository
- **THEN** it reports no gaps
