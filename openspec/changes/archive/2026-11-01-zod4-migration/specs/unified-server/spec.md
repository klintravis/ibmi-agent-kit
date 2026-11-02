## ADDED Requirements

### Requirement: Installed dependencies carry no known advisories
A fresh install of the packages SHALL report no vulnerabilities from `npm audit`, with or without development dependencies.

#### Scenario: Audit is clean
- **WHEN** `npm audit` and `npm audit --omit=dev` are run by hand before a merge, on the committed lockfile
- **THEN** both report 0 vulnerabilities (a merge-time check, not part of CI: an unrelated future advisory must not fail the build)
