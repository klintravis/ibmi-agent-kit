# Spec Delta

## ADDED Requirements

### Requirement: The bootstrap starts in an empty company repo
The `ibmi-kit-config` bootstrap SHALL refuse a folder that holds anything besides `.git`, `README*`,
`LICENSE*`, `.gitignore` and the session's own Claude Code files (a `.mcp.json` registering
ibmi-agent-kit, a `.claude` folder with only `skills/` and `settings.local.json`), naming what it
found and why; a folder with this kit's `policy.yaml` SHALL go to Maintain instead.

#### Scenario: Wrong folder
- **WHEN** the working folder has a `package.json` or a `packages/` folder and no `policy.yaml`
- **THEN** the skill stops, names those entries, and writes nothing
