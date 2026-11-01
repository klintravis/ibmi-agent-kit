## MODIFIED Requirements

### Requirement: The skill is not shipped to end users
Published kit packages SHALL NOT include the skill or the templates. A selfcheck SHALL fail when
any package's `files` list in `package.json` names or globs `.claude` or `templates`.

#### Scenario: Packed contents
- **WHEN** a kit package is packed
- **THEN** the archive contains no `.claude/` or `templates/` paths, and the selfcheck on every
  package's `files` list guards this on each CI run
