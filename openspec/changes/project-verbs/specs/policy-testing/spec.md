# Spec Delta

## Purpose

Lets a company test its verbs against its policy in CI, as it tests scripts.

## ADDED Requirements

### Requirement: Verb cases decide what the verb would send
A policy test case with `verb` and `args` instead of `script` SHALL decide every statement the
verb would send, nested verbs and cleanup included. Its verb SHALL be found in `.ibmi-kit/verbs/`
in the working directory or `verbs/` beside the policy file; a person's own verbs SHALL NOT be
read. A `requires_absent` or `expect` query that does more than read SHALL decide as `deny`.

#### Scenario: Team verb in CI
- **WHEN** a case runs `verb: FIX-ORDERS` as an analyst on an enforcing partition and the verb writes a library the analyst's rules deny
- **THEN** the case's decision is `deny`, naming the verb's step

#### Scenario: Expectation query that writes
- **WHEN** a verb's `requires_absent` is `SELECT * FROM OLD TABLE (DELETE ...)`
- **THEN** that statement decides as `deny`, naming the read-only rule
