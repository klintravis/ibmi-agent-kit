## ADDED Requirements

### Requirement: Quick-start demo
The repository SHALL ship `docs/demo.md` and `examples/demo/` policies (observe and enforce) with
tests that pass under `policy test`, using placeholder names only.

#### Scenario: Demo policies stay valid
- **WHEN** `policy test` runs on each demo policy with its tests
- **THEN** it exits 0
