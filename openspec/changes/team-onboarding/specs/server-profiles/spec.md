# Spec Delta

## ADDED Requirements

### Requirement: setup recognises a company config repo
When the current folder holds a `policy.yaml` file and a `profiles/` folder, `setup` SHALL run in
company-repo mode. The partitions are the profile names of the `profiles/.env.<partition>` files,
by the loader's file rules. Folders above the current one SHALL NOT be searched.

#### Scenario: Partitions offered
- **WHEN** `setup` runs with no name in a folder holding `policy.yaml` and `profiles/.env.dev`,
  `profiles/.env.prod` and `profiles/.env.example`
- **THEN** it offers `dev` and `prod` to choose from, and writes the profile named after the choice

#### Scenario: One partition
- **WHEN** the repo holds a single skeleton
- **THEN** `setup` uses it without asking which

#### Scenario: Unknown name
- **WHEN** `setup qa` runs in a company repo with no `profiles/.env.qa`
- **THEN** it exits non-zero naming the partitions found and writes nothing

#### Scenario: Not a company repo
- **WHEN** the current folder lacks `policy.yaml` or `profiles/`
- **THEN** `setup` asks for host, user, password and policy as it does outside a repo

### Requirement: setup takes the company's settings from the repo
In company-repo mode `setup` SHALL copy every setting of the chosen skeleton into the profile except
`IBMI_USER`, `IBMI_PASSWORD` and `IBMI_KIT_POLICY`, SHALL write `IBMI_KIT_POLICY` as the absolute
path of the repo's `policy.yaml`, and SHALL ask only the user and the hidden password. A skeleton
without `IBMI_HOST` or `IBMI_PARTITION`, or a policy that does not load, SHALL be refused with
nothing written.

#### Scenario: Other skeleton settings copied
- **WHEN** `profiles/.env.dev` holds `IBMI_SQL_TRANSPORT=mapepire` and `IBMI_KIT_POLICY=/admin/policy.yaml`
- **THEN** the profile `dev` holds `IBMI_SQL_TRANSPORT=mapepire`, the connection test uses it, and
  its `IBMI_KIT_POLICY` is the clone's `policy.yaml`, not the skeleton's path

#### Scenario: Policy path written
- **WHEN** a colleague runs `setup dev` in a clone at any folder
- **THEN** the profile `dev` holds the skeleton's host and partition and `IBMI_KIT_POLICY` set to
  that clone's `policy.yaml` as an absolute path, and the connection test runs as before

#### Scenario: Placeholder user not offered
- **WHEN** the skeleton's `IBMI_USER` is `YOUR_USER` and no profile `dev` exists yet
- **THEN** the user prompt offers no default

#### Scenario: Policy path replaced
- **WHEN** the existing profile `dev` names a different `IBMI_KIT_POLICY`
- **THEN** `setup` says it replaces that path and writes the repo's

#### Scenario: Host replaced
- **WHEN** the existing profile `dev` holds a password for an `IBMI_HOST` other than the skeleton's
- **THEN** `setup` prints the skeleton's partition and host and that it replaces the old host,
  asks for a password without offering to keep the current one, and neither writes nor sends the
  old password to the new host

### Requirement: setup never puts a password in the company repo
In company-repo mode `setup` SHALL NOT write any file inside the repo, SHALL refuse to run when the
first profile folder, or a partition's profile file in it, resolves to a path inside the repo
(symlinks followed, the repo folder recognised under any spelling), and SHALL ignore a skeleton's `IBMI_PASSWORD` with a
warning naming the file.

#### Scenario: Repo unchanged
- **WHEN** `setup` completes in a company repo
- **THEN** every file in the repo is byte-identical to before and none contains the password

#### Scenario: Profile folder inside the repo
- **WHEN** `IBMI_KIT_CONFIG_DIR` points at a folder inside the repo
- **THEN** `setup` exits non-zero before the first prompt and writes nothing

#### Scenario: Profile folder linked into the repo
- **WHEN** `IBMI_KIT_CONFIG_DIR` points at a folder outside the repo that is a symlink or junction
  to a folder inside it
- **THEN** `setup` exits non-zero before the first prompt and writes nothing

#### Scenario: Skeleton holds a password
- **WHEN** `profiles/.env.dev` contains `IBMI_PASSWORD=x`
- **THEN** `setup` warns that the file holds a password and to remove it from the repo, never
  writes `x` to the profile, and asks for the password as usual

### Requirement: setup points at the kit for the repo's server registration
In company-repo mode, when the repo's `.mcp.json` refers to `${IBMI_KIT_HOME}` and that variable is
not set, `setup` SHALL print the kit folder it runs from as the value to give `IBMI_KIT_HOME`. It
SHALL NOT set the variable itself.

#### Scenario: Variable unset
- **WHEN** `setup` runs in a company repo whose `.mcp.json` uses `${IBMI_KIT_HOME}`, without that
  variable in its environment
- **THEN** its output names the kit folder to set `IBMI_KIT_HOME` to

#### Scenario: Registration without the variable
- **WHEN** the repo's `.mcp.json` does not mention `IBMI_KIT_HOME`
- **THEN** `setup` prints no such hint
