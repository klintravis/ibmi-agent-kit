# Company config repo (template)

What a company's private repo for its ibmi-agent-kit configuration looks like. The `ibmi-kit-config`
skill generates these files; an admin can also copy them by hand. This folder is not published.
Copy a policy from [../policies](../policies) to `policy.yaml` (with its tests), never reference it.

```
<company-repo>/
  README.md                      what this repo is, the date of the last maintenance run
  policy.yaml                    the execution policy (observe mode first)
  policy.tests.yaml              one allow and one deny per role x environment
  commands.yaml                  optional command file, listed under command_files in policy.yaml
  profiles/.env.<partition>      profile skeleton per partition: host, user, transport, IBMI_PARTITION
  verbs/smoke.yaml               org-layer verbs, found beside policy.yaml; one smoke verb to start
  .github/workflows/policy.yml   CI: policy test on every push
  .claude/settings.json          client permission rules (below)
```

## Profiles

Each `profiles/.env.<partition>` holds `IBMI_HOST`, `IBMI_USER` (a placeholder), the transport,
`IBMI_PARTITION` and `IBMI_KIT_POLICY` (absolute path to `policy.yaml` on that machine), with a
comment where the password goes. **A password is never written to this repo.** Each person copies
the file to `~/.ibmi-agent-kit/.env.<partition>` and sets their own password there.

## Policy and tests

Start in `mode: observe`: everything is decided and logged, nothing extra is blocked. Check:

```
ibmi-agent-kit policy test policy.yaml policy.tests.yaml
```

Read the run log, then `ibmi-agent-kit policy replay` a candidate edit before changing a rule, and
move partitions to `enforce` one at a time. See [docs/policy.md](../../docs/policy.md).

## CI

`.github/workflows/policy.yml` runs `policy test` on every push and pull request, so a policy edit
that breaks its tests cannot merge.

```yaml
name: policy
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/checkout@v4
        with:
          repository: klintravis/ibmi-agent-kit
          ref: main            # pin a tag or commit SHA
          path: kit
      - run: npm ci && npm run check
        working-directory: kit
      - run: node kit/packages/server/dist/index.js policy test policy.yaml policy.tests.yaml
```

Nothing is published to npm, so CI builds the kit from its repo (the install steps in the root README).

## Client permission rules

Keep the agent from editing the policy, profiles and verbs. In `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "Edit(policy.yaml)", "Edit(policy.tests.yaml)", "Edit(commands.yaml)",
      "Edit(profiles/**)", "Edit(verbs/**)",
      "Read(~/.ibmi-agent-kit/**)"
    ]
  }
}
```

The `ibmi-kit-config` skill works on a branch and an admin edits through it deliberately, so lift
these rules for that session, or let the admin make the edit.

## Maintenance

Note the date of each run here: the next run summarises the run log since then.

Last maintenance run: (none yet)
