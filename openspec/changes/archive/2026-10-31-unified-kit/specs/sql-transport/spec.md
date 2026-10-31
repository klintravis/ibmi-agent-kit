# Spec Delta

## Purpose

Gives every kit component one way to send SQL and CL to an IBM i, independent of how the
connection is made, so a shop can choose the connection its security rules allow.

## ADDED Requirements

### Requirement: The transport is chosen per profile
A profile SHALL select its SQL transport with `IBMI_SQL_TRANSPORT`: `ssh` (default) connects over
SSH and runs the bundled Mapepire server in the user's job; `daemon` connects to a Mapepire server
already running on the IBM i at `IBMI_MAPEPIRE_PORT` (default 8076) and uploads nothing. An
unknown value SHALL fail the profile load naming the allowed values.

#### Scenario: Daemon transport uploads nothing
- **WHEN** a profile sets `IBMI_SQL_TRANSPORT=daemon` and `run_sql` is called
- **THEN** the query runs over the daemon connection and no SSH connection or file upload is made

#### Scenario: Unknown transport
- **WHEN** a profile sets `IBMI_SQL_TRANSPORT=odbc`
- **THEN** loading it fails naming `ssh` and `daemon`

### Requirement: The transport executes, not only queries
Every transport SHALL offer: query (rows and column types, bounded), execute (a non-query
statement with bound parameter values, returning rows affected and messages), and CL command
execution (returning success and messages). All three SHALL run in the signed-on user's job.

#### Scenario: Bound parameters
- **WHEN** execute is called with `UPDATE A.T SET C = ? WHERE K = ?` and values `x' or '1'='1` and `5`
- **THEN** the values are sent as bound parameters and the statement text is unchanged

#### Scenario: CL failure messages
- **WHEN** a CL command fails on the IBM i
- **THEN** the result reports failure and the IBM i message identifiers and text

### Requirement: Engine behaviour is unchanged on the default transport
With `IBMI_SQL_TRANSPORT` unset, every source-engine tool SHALL behave as before this change.

#### Scenario: Source checks unchanged
- **WHEN** the source package's checks run after this change
- **THEN** every pre-existing check passes
