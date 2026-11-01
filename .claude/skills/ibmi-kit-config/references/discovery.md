# Discovery queries

The read-only queries the `ibmi-kit-config` skill runs, grouped by what they feed. Each one is a
single `SELECT`, sent with `run_sql` (`json: true`, an explicit `maxRows`, and `server` set to the
partition's profile). `run_sql` refuses anything that is not a select, a statement with a comment
or an inner `;` (one trailing `;` is stripped), and a write hidden in a select.

Rules for running them:

- Run every group on every partition's profile unless the group says otherwise.
- Replace the quoted placeholders (`'WD%'`, `'XCMLIB'`, `'GRPDEV'`) with names found by an earlier
  query, in upper case. Never splice in text the admin typed without checking it is an IBM i name.
- Prefer the aggregate queries: they keep a shop with thousands of users or libraries down to a
  few rows. Never pass `file: true`: it writes user and group lists into the working folder.
- The release given is the first one IBM's services table lists the view at, with the PTF group
  level for a technology refresh (`7.3 TR SF99703 L22`); that table starts at 7.3, so `7.3` means
  "at 7.3 base, maybe earlier". Check the box's release with S2 first.
- A missing view (`SQL0204`) or column (`SQL0206`) is reported and the question it feeds in
  `questions.md` is asked directly. Column names can differ by release: to see a view's columns,
  run `SELECT * FROM <view>` with `maxRows: 0`, which returns the columns and types only.
- Results are limited to what the admin's own profile may read. A view that returns fewer rows
  than expected (no other users, no private authorities) is reported as partial.
- Names are system names (at most 10 characters) unless a column says otherwise; RDB names may
  have up to 18.

## System (feeds `partitions`, `unknown_partition`)

| Id | Release | Feeds |
|---|---|---|
| S1 | any | `partitions[].rdbs`: the RDB name the guard reads (`CURRENT SERVER`) |
| S2 | 7.3 | the release, which decides which of the other queries can run |
| S3 | 7.3 TR SF99703 L22 (`HOST_NAME`) | `partitions[].systems`: the system name, as on the 5250 sign-on screen |
| S4 | 7.4 TR SF99704 L25 | `partitions[].systems` when S3 has no `HOST_NAME` |
| S5 | 7.3 TR SF99703 L7 | `partitions[].rdbs`: each independent ASP's own RDB name |
| S6 | 7.4 TR SF99704 L25 | cross-check: every RDB another partition answers to; an RDB no partition lists is `danger` |

```sql
SELECT CURRENT SERVER AS RDB, CURRENT USER AS USR FROM SYSIBM.SYSDUMMY1
SELECT OS_VERSION, OS_RELEASE FROM SYSIBMADM.ENV_SYS_INFO
SELECT HOST_NAME, PARTITION_ID, NUMBER_OF_PARTITIONS FROM QSYS2.SYSTEM_STATUS_INFO
SELECT HOST_NAME, NETWORK_ID FROM QSYS2.NETWORK_ATTRIBUTE_INFO
SELECT ASP_NUMBER, DEVICE_DESCRIPTION_NAME, RDB_NAME, ASP_TYPE, ASP_STATE FROM QSYS2.ASP_INFO WHERE ASP_NUMBER > 32
SELECT RDB_NAME, REMOTE_LOCATION FROM QSYS2.RDB_ENTRY_INFO
```

S1 to S6 in order. S6 runs on one partition only; `REMOTE_LOCATION` is `*LOCAL` for the box itself.

## Libraries (feeds `environments`)

| Id | Release | Feeds |
|---|---|---|
| L1 | 7.3 | `environments[].match`: library prefixes of 2 characters with at least 3 libraries (repeat with `SUBSTR(OBJNAME, 1, 3)` for 3) |
| L2 | 7.3 | evidence per prefix: names, owners and text, shown with the ladder question |
| L3 | any | test `lookups.schemas`: long SQL schema names and their system names |
| L4 | 7.3 TR SF99703 L18 | size of a shortlisted library; slow, one library per query, only when the admin asks |

```sql
SELECT SUBSTR(OBJNAME, 1, 2) AS PREFIX, COUNT(*) AS LIBS FROM TABLE(QSYS2.OBJECT_STATISTICS('*ALLUSR', '*LIB')) X GROUP BY SUBSTR(OBJNAME, 1, 2) HAVING COUNT(*) >= 3 ORDER BY 2 DESC
SELECT OBJNAME, OBJOWNER, OBJDEFINER, OBJCREATED, OBJTEXT FROM TABLE(QSYS2.OBJECT_STATISTICS('*ALLUSR', '*LIB')) X WHERE OBJNAME LIKE 'WD%' ORDER BY OBJNAME
SELECT SCHEMA_NAME, SYSTEM_SCHEMA_NAME FROM QSYS2.SYSSCHEMAS WHERE SCHEMA_NAME <> SYSTEM_SCHEMA_NAME
SELECT OBJECT_COUNT, LIBRARY_SIZE FROM TABLE(QSYS2.LIBRARY_INFO('WDORD')) X
```

L2 runs once per prefix L1 found, with `maxRows` of the prefix's count.

## Identity (feeds `roles`, `default_role`, the personal environment)

| Id | Release | Feeds |
|---|---|---|
| I1 | 7.3 | `roles[].groups` candidates, and the personal convention: `OWN_CURLIB` counts users whose current library is their own name |
| I2 | 7.3 | `roles[].groups`: members per group, supplemental groups included |
| I3 | 7.3 | evidence only: enabled users with `*ALLOBJ`, shown so the admin knows who the guard cannot hold back |
| I4 | 7.3 TR SF99703 L4 | `roles[].authlists` candidates |

```sql
SELECT GROUP_PROFILE_NAME, COUNT(*) AS USERS, SUM(CASE WHEN CURRENT_LIBRARY_NAME = AUTHORIZATION_NAME THEN 1 ELSE 0 END) AS OWN_CURLIB FROM QSYS2.USER_INFO WHERE STATUS = '*ENABLED' AND GROUP_MEMBER_INDICATOR = 'NO' GROUP BY GROUP_PROFILE_NAME ORDER BY 2 DESC
SELECT GROUP_PROFILE_NAME, COUNT(*) AS MEMBERS FROM QSYS2.GROUP_PROFILE_ENTRIES GROUP BY GROUP_PROFILE_NAME ORDER BY 2 DESC
SELECT AUTHORIZATION_NAME, GROUP_PROFILE_NAME FROM QSYS2.USER_INFO WHERE STATUS = '*ENABLED' AND SPECIAL_AUTHORITIES LIKE '%*ALLOBJ%'
SELECT AUTHORIZATION_LIST, COUNT(*) AS USERS FROM QSYS2.AUTHORIZATION_LIST_USER_INFO GROUP BY AUTHORIZATION_LIST ORDER BY 2 DESC
```

Identity is usually the same on every partition; run it on one and spot-check another.

## Change authority (feeds `rules`)

| Id | Release | Feeds |
|---|---|---|
| A1 | 7.3 TR SF99703 L4 | `rules`: which groups hold `*CHANGE` or `*ALL` on each environment's libraries, the evidence for role × environment allows |

```sql
SELECT AUTHORIZATION_NAME, OBJECT_AUTHORITY, COUNT(*) AS LIBS FROM QSYS2.OBJECT_PRIVILEGES WHERE OBJECT_SCHEMA = 'QSYS' AND OBJECT_TYPE = '*LIB' AND SYSTEM_OBJECT_NAME LIKE 'WD%' GROUP BY AUTHORIZATION_NAME, OBJECT_AUTHORITY ORDER BY 3 DESC
```

One query per environment prefix, on the partition the environment lives on. Library authority is
a proxy: objects inside may be secured differently, so say so with the evidence.

## Library lists (feeds the ladder order and test `curlib`)

| Id | Release | Feeds |
|---|---|---|
| J1 | 7.3 | the job descriptions each group signs on with |
| J2 | 7.3 TR SF99703 L11 | their library lists: the order libraries are searched is evidence for the ladder order |

```sql
SELECT GROUP_PROFILE_NAME, JOB_DESCRIPTION_LIBRARY_NAME, JOB_DESCRIPTION_NAME, COUNT(*) AS USERS FROM QSYS2.USER_INFO WHERE STATUS = '*ENABLED' GROUP BY GROUP_PROFILE_NAME, JOB_DESCRIPTION_LIBRARY_NAME, JOB_DESCRIPTION_NAME ORDER BY 4 DESC
SELECT JOB_DESCRIPTION_LIBRARY, JOB_DESCRIPTION, LIBRARY_LIST FROM QSYS2.JOB_DESCRIPTION_INFO WHERE JOB_DESCRIPTION_LIBRARY = 'WDJOBD' AND JOB_DESCRIPTION = 'DEVJOBD'
```

`LIBRARY_LIST` packs names into 11-character slots.

## Change management (feeds `commands.yaml`, promote rules)

| Id | Release | Feeds |
|---|---|---|
| C1 | 7.3 TR SF99703 L22 | installed non-IBM licensed programs; many change-management products do not register as one |
| C2 | 7.3 | product libraries, found by their text |
| C3 | 7.3 | the commands in a product library: `commands.<name>` candidates |
| C4 | 7.4 TR SF99704 L23 | each command's text and processing program; it has no parameter keywords, so the promote parameter is a question |

```sql
SELECT PRODUCT_ID, PRODUCT_OPTION, RELEASE_LEVEL, TEXT_DESCRIPTION FROM QSYS2.SOFTWARE_PRODUCT_INFO WHERE INSTALLED = 'YES' AND PRODUCT_ID NOT LIKE '57%'
SELECT OBJNAME, OBJOWNER, OBJTEXT FROM TABLE(QSYS2.OBJECT_STATISTICS('*ALLUSR', '*LIB')) X WHERE UPPER(OBJTEXT) LIKE '%CHANGE%' OR UPPER(OBJTEXT) LIKE '%PROMOT%'
SELECT OBJNAME, OBJTEXT FROM TABLE(QSYS2.OBJECT_STATISTICS('XCMLIB', '*CMD')) X ORDER BY OBJNAME
SELECT COMMAND_NAME, TEXT_DESCRIPTION, COMMAND_PROCESSING_PROGRAM_LIBRARY, COMMAND_PROCESSING_PROGRAM FROM QSYS2.COMMAND_INFO WHERE COMMAND_LIBRARY = 'XCMLIB'
```

A product's own files (request tables, level definitions) are never read: the skill asks instead.

## How the guard sees these

Each query is a `read`: `QSYS2.OBJECT_STATISTICS` and `QSYS2.LIBRARY_INFO` are on the guard's list
of catalog table functions; the rest are views. Under the built-in policy and every template
(`{ classes: [read], decision: allow }`) they are allowed, and each is written to the run log.
