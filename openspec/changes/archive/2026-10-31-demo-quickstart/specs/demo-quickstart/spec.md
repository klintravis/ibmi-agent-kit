## ADDED Requirements

### Requirement: Quick-start demo
The repository SHALL ship `docs/demo.md` and `examples/demo/` policies (observe and enforce) with
tests that pass under `policy test`, using placeholder names only.

#### Scenario: Demo policies stay valid
- **WHEN** `policy test` runs on each demo policy with its tests
- **THEN** it exits 0

### Requirement: Guided demo skill
The repository SHALL ship a `demo` skill that walks the user through `docs/demo.md` and never asks
for, reads or writes the profile password.

#### Scenario: Skill references stay real
- **WHEN** the selfcheck reads the skill
- **THEN** every tool name and repo path it names exists, and its connection query is read-only
