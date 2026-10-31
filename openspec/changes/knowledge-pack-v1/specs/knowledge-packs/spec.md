# Spec Delta

## Purpose

Lets any team teach the kit one enterprise's IBM i — its objects, their business meaning and its
vocabulary — by writing reviewable text files instead of code.

## ADDED Requirements

### Requirement: A pack is a folder of text files with a manifest
A knowledge pack SHALL be a folder containing a `pack.yaml` manifest that declares at least a
`name` and a `version`. The optional sections `schema`, `glossary`, `queries`, `workflows` and
`safety` SHALL be read from files in the same folder. A pack SHALL contain no executable code.

#### Scenario: Minimal pack loads
- **WHEN** a folder contains only a `pack.yaml` with `name: demo` and `version: 1.0.0`
- **THEN** the pack loads and reports no schema, glossary, queries or workflows

#### Scenario: Manifest missing
- **WHEN** a configured pack folder has no `pack.yaml`
- **THEN** the server reports that folder as not a pack, naming the path, and still starts

### Requirement: Pack names are safe identifiers
A pack `name` SHALL match `^[a-z][a-z0-9_]{0,30}$`, because it prefixes MCP tool names.

#### Scenario: Invalid name refused
- **WHEN** a manifest declares `name: My-Pack`
- **THEN** the pack is refused with an error naming the rule, and other packs still load

### Requirement: Packs are loaded from configured local folders
The server SHALL load every pack found in the folders listed in `IBMI_KIT_PACKS` (separated by the
platform path delimiter). A listed folder that is itself a pack SHALL load as one pack; a folder
of packs SHALL load each child that has a `pack.yaml`. No packs configured SHALL NOT be an error.

#### Scenario: Folder of packs
- **WHEN** `IBMI_KIT_PACKS` names a folder holding `sales/pack.yaml` and `hr/pack.yaml`
- **THEN** both packs load

#### Scenario: No packs configured
- **WHEN** `IBMI_KIT_PACKS` is unset
- **THEN** the server starts with the engine tools only and `pack_list` reports no packs

### Requirement: Invalid packs fail loudly and alone
Every pack file SHALL be validated at startup. A pack with any validation error SHALL be refused
as a whole, with each error naming its file and the offending key, and SHALL NOT prevent other
packs from loading. Unknown keys SHALL be errors, so a typo cannot silently drop meaning.

#### Scenario: Typo in a key
- **WHEN** `schema/customers.yaml` contains `discription:` instead of `description:`
- **THEN** that pack is refused with an error naming `schema/customers.yaml` and `discription`

#### Scenario: Duplicate pack names
- **WHEN** two loaded folders both declare `name: sales`
- **THEN** the second is refused with an error naming both paths

### Requirement: Schema entries describe objects in business terms
A pack's schema SHALL describe files (tables) by library and system name, with a business
description, and optionally each field's business meaning, unit, allowed values and key order.
The kit SHALL NOT require a schema entry to exist on the system at load time.

#### Scenario: Field meaning exposed
- **WHEN** a schema entry gives `CUSMST.CMCRLM` the meaning "credit limit" and unit "USD"
- **THEN** `pack_describe` for that file returns the field with that meaning and unit

### Requirement: Glossary terms resolve to objects
A pack's glossary SHALL map business terms (with optional synonyms) to a description and to the
schema objects, fields, values, queries or workflows they refer to. References SHALL be validated
against the same pack at load time.

#### Scenario: Term lookup
- **WHEN** an agent calls `pack_lookup` with "credit hold"
- **THEN** it receives the term's description and the referenced field and value

#### Scenario: Dangling reference
- **WHEN** a glossary term refers to a query that the pack does not declare
- **THEN** the pack is refused with an error naming the term and the missing query

### Requirement: Read-only pack inspection tools
The server SHALL expose `pack_list`, `pack_describe` and `pack_lookup`. All three SHALL be
annotated read-only, SHALL NOT contact the IBM i, and SHALL return structured content as well as
text.

#### Scenario: Describe filtered
- **WHEN** `pack_describe` is called with `pack: sales` and `filter: credit`
- **THEN** only schema entries, terms, queries and workflows matching "credit" are returned

#### Scenario: Lookup with no match
- **WHEN** `pack_lookup` finds no term, synonym or field matching the input
- **THEN** it returns an empty result and the closest term names, not an error
