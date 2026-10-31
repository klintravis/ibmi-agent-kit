# Spec Delta

## Purpose

Gives an adopter one MCP server to register that carries the screen engine, the source engine and
every loaded pack, with safety that packs can tighten but never loosen.

## ADDED Requirements

### Requirement: One stdio server mounts every tool
The kit SHALL run as a single MCP server over stdio that exposes all screen-engine tools, all
source-engine tools and all pack tools. It SHALL run with Node 18 or later on Windows, macOS and
Linux, without Docker.

#### Scenario: Registered once
- **WHEN** a client registers only the kit server and lists tools
- **THEN** it sees `session_open`, `run_sql`, `pack_list` and every pack query tool

### Requirement: Engine tools keep their behaviour
Each engine tool mounted by the kit SHALL accept the same inputs and return the same results as
when that engine runs standalone. Both engines SHALL remain runnable standalone.

#### Scenario: Standalone still works
- **WHEN** the screen engine is started on its own after this change
- **THEN** it serves its original tools and passes its own self-checks

### Requirement: Shared tools appear once
Where both engines provide a tool with the same name and meaning (`list_servers`), the kit SHALL
expose it once. Any other name clash SHALL stop the server at startup with an error naming the
tool, rather than letting one silently replace the other.

#### Scenario: list_servers deduplicated
- **WHEN** the kit lists its tools
- **THEN** `list_servers` appears exactly once and lists the same profiles both engines read

### Requirement: Packs can only tighten safety
A pack's `safety` section MAY add blocked CL commands, add blocked tables, or require read-only
for named server profiles. It SHALL NOT remove a blocked command or table, allow a command, turn
off restricted mode, or turn off read-only. Any key that would loosen a guard SHALL be a load
error.

#### Scenario: Pack adds a blocked table
- **WHEN** a pack's safety lists `PAYROLL.PAYMST` as blocked
- **THEN** `run_sql` and every query tool refuse to read `PAYROLL.PAYMST` on every profile

#### Scenario: Pack tries to loosen
- **WHEN** a pack's safety sets `restricted: false`
- **THEN** the pack is refused with an error saying packs may only tighten safety

#### Scenario: Read-only for one profile
- **WHEN** a pack requires read-only for profile `prod`
- **THEN** `upload_source_member` and `compile_member` are refused on `prod` and allowed on other
  profiles as their own settings permit

### Requirement: Credentials never pass through tools or packs
The kit SHALL read credentials only from the engines' existing profile files. No tool input, tool
result or pack file SHALL carry a password, and a pack key that looks like a credential
(`password`, `secret`, `token`) SHALL be a load error.

#### Scenario: Password in a pack
- **WHEN** a pack's `pack.yaml` contains `password: hunter2`
- **THEN** the pack is refused with an error that names the key but not the value
