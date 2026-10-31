# Spec Delta

## Purpose

Turns the SQL an enterprise already trusts into typed, read-only MCP tools declared in a pack, so
an existing SQL-based MCP can be ported by moving its queries into YAML.

## ADDED Requirements

### Requirement: Each declared query becomes one MCP tool
Every entry in a pack's `queries` SHALL be exposed as an MCP tool named `<pack>_<query>`, carrying
the query's description and a typed input schema built from its declared parameters.

#### Scenario: Query appears as a tool
- **WHEN** pack `sales` declares query `open_orders` with parameter `customer`
- **THEN** the tool list contains `sales_open_orders` with a required string input `customer`

#### Scenario: Name collision
- **WHEN** a generated tool name equals an existing engine or pack tool name
- **THEN** the pack is refused with an error naming both, and the existing tool is unchanged

### Requirement: Parameters are typed and bound, never spliced
Query parameters SHALL declare a type (`string`, `integer`, `decimal`, `date`, `boolean`) and may
declare required, default, allowed values, and string length. Values SHALL be validated against
the declaration, then passed to Db2 as bound parameter markers, never inserted into SQL text.

#### Scenario: Wrong type refused
- **WHEN** `sales_open_orders` is called with `limit: "ten"` for an integer parameter
- **THEN** the call fails validation and nothing is sent to the IBM i

#### Scenario: Injection attempt is inert
- **WHEN** a string parameter is given `x' or '1'='1`
- **THEN** it is bound as a literal value and the statement text sent to Db2 is unchanged

#### Scenario: Placeholder count mismatch
- **WHEN** a query's SQL has two `?` markers but declares three parameters
- **THEN** the pack is refused at load time with an error naming the query

### Requirement: Pack queries are select-only
A pack query's SQL SHALL pass the same select-only check and blocked-table check the source
engine applies to `run_sql`, at load time and again at call time against the server profile in
use. Query tools SHALL be annotated read-only.

#### Scenario: Update refused at load
- **WHEN** a pack declares a query whose SQL is `update ORDHDR set OHHOLD = ' '`
- **THEN** the pack is refused with an error naming the query

#### Scenario: Blocked table at call time
- **WHEN** a query reads a table the selected server profile lists in `IBMI_BLOCKED_TABLES`
- **THEN** the call is refused before reaching the IBM i, naming the table

### Requirement: Query results are structured and bounded
A query tool SHALL return its rows as structured content with column names and types, plus a text
table. It SHALL apply the query's declared `maxRows` (default 100), report truncation, and accept
the engine's `server` argument to choose the target IBM i.

#### Scenario: Truncated result
- **WHEN** a query with `maxRows: 50` matches 80 rows
- **THEN** 50 rows are returned and the result says it was truncated at 50

#### Scenario: Server selection
- **WHEN** a query tool is called with `server: pub400`
- **THEN** it runs against the `.env.pub400` profile, like the engine tools do

### Requirement: Field meaning travels with results
When a result column matches a field the same pack's schema describes, the structured result
SHALL include that field's business meaning and unit alongside the column.

#### Scenario: Annotated column
- **WHEN** `sales_open_orders` returns column `CMCRLM` and the schema gives it "credit limit, USD"
- **THEN** the column metadata in the result includes "credit limit" and "USD"
