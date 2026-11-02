## ADDED Requirements

### Requirement: Installed dependencies carry no known advisories
A fresh install of the packages SHALL report no vulnerabilities from `npm audit`, with or without development dependencies.

#### Scenario: Audit is clean
- **WHEN** `npm audit` and `npm audit --omit=dev` run on the committed lockfile
- **THEN** both report 0 vulnerabilities
