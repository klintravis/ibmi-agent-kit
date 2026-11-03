## Why

`.github/workflows/check.yml` sets no job timeout, so a test that leaves something running (a viewer
server, say) keeps the runner busy for GitHub's six-hour default and CI never goes red. The slowest
leg takes about three minutes today.

## What Changes

- The `check` job gets `timeout-minutes: 15`.

CI only. No package code changes. No MCP tool is added or changed. No spec delta.

## Out of scope

`--test-force-exit` in the package test scripts: it needs a Node version check against the floor, and
the timeout already turns a hang into a red run.
