# Questions

One question per thing discovery cannot settle. Ask them one at a time, in this order, each with
its evidence (the query ids from `discovery.md` and their rows) and the recommended answer, which
the admin can accept as is. Skip a question when discovery settled it and the admin confirmed the
inference. Never ask for a password, a token or a key, and never accept one: if the admin offers
one, say it belongs in their own copy of the profile, not in this session.

`Fills` names the exact key written. Policy keys are those of the policy schema
(`packages/guard/src/policy.ts`, `policySchema`); a name that breaks a rule below is refused by
`policy test`, so check it when the answer comes in.

Name rules: partition, environment and role names are letters, digits, `_` and `-` (not `any`);
system names, groups, authorization lists and exact libraries are IBM i names of at most 10
characters; RDB names at most 18; `match` and `users` patterns use name characters, `*` and
`${USER}`; classes are lower case letters, digits and `_`.

## Partitions

| Id | Question | Recommended | Fills |
|---|---|---|---|
| Q1 | Which partitions does the kit serve, and what is each called? | One per profile in `list_servers`, named as the profile (`dev`, `qa`, `prod`), with S3's system name and S1's RDB (plus S5's IASP RDBs) | `partitions[].name`, `partitions[].systems`, `partitions[].rdbs` |
| Q2 | S3 and S4 gave no system name for a partition. What does the `System` field on its sign-on screen say? | Leave `systems` out and list `rdbs` only; the RDB name and `IBMI_PARTITION` still decide | `partitions[].systems` |
| Q3 | Which partition applies to a box no entry names? | The production partition: the strictest rules apply to the unknown | `unknown_partition` |

## Environments

| Id | Question | Recommended | Fills |
|---|---|---|---|
| Q4 | Is this the ladder, in this order, and on these partitions? (L1 prefixes with counts, L2 text, J2 library-list order) | Prefixes ordered as development → production, each on the partition where L1 found it, named `dev`, `integ`, `test`, `live` | `environments[].name`, `environments[].match`, `environments[].partitions` |
| Q5 | Do developers own a library named after themselves? (I1 `OWN_CURLIB` of `USERS`) | Yes when at least half of a group's users have it: `match: ["${USER}"]` on the development partition | `environments[]` entry `personal`: `match`, `partitions` |
| Q6 | Any ladder prefix starting with `Q` or `SYS`? | Keep `system` as `match: ["Q*", "SYS*"]`, and put such a prefix's entry before it | `environments[]` entry `system`: `match`; entry order |
| Q7 | Libraries that must never be written through the agent (payroll, audit)? | None at bootstrap; list them later as an exact-name environment with a deny rule | `environments[].libraries`, `rules[].env`, `rules[].decision` |

`scratch` (`libraries: [QTEMP]`) is always generated first and is not asked.

## Roles

| Id | Question | Recommended | Fills |
|---|---|---|---|
| Q8 | Are these the roles? (I1 and I2 groups, with A1's change authority per environment) | One role per group that holds `*CHANGE` or `*ALL` on an environment, named for what it does; one read-only role for the largest remaining group | `roles[].name`, `roles[].groups` |
| Q9 | Does an authorization list mean a role? (I4) | No, unless an authorization list secures a ladder environment's libraries | `roles[].authlists` |
| Q10 | Users matched by name, such as contractors (`CTR*`)? | None | `roles[].users` |
| Q11 | Which role does a user no role matches hold? | The read-only role | `default_role` |

## Rules

| Id | Question | Recommended | Fills |
|---|---|---|---|
| Q12 | Which role may change what, where? (A1) | Allow each role every class in the environments its group may change, on that environment's partition; reads everywhere; nothing else | `rules[].roles`, `rules[].partition`, `rules[].env`, `rules[].decision` |
| Q13 | Anything to ask before it runs (`confirm`), such as DDL in integration? | None at bootstrap: observe mode logs everything, and the run log shows where a confirm would help | `rules[].classes`, `rules[].decision` |

`mode` is not asked: bootstrap always writes `mode: observe`.

## Change management

| Id | Question | Recommended | Fills |
|---|---|---|---|
| Q14 | Which command promotes, and which parameter names the level? (C2, C3, C4: no parameter keywords are discoverable) | One entry per promote command, qualified to its product library, with a class per level and `danger` for any other value; read-only commands of the product as `read` | `commands.yaml`: `commands.<CMD>.class_by_param` (`param`, `values`, `default`), `library`, `positional`, `class`; policy `command_files: [commands.yaml]` |
| Q15 | Who may promote to which level through the agent? | Each role to the level after its own environment; nobody to production | `rules[].roles`, `rules[].partition`, `rules[].classes` (`promote_<level>`), `rules[].decision` |

## Profiles, tests and the smoke verb

| Id | Question | Recommended | Fills |
|---|---|---|---|
| Q16 | Each partition's host name and SQL transport? | The host from S6's `REMOTE_LOCATION` where it is a host name, else ask; transport `ssh` (the kit's default) | `profiles/.env.<partition>`: `IBMI_HOST`, `IBMI_SQL_TRANSPORT` |
| Q17 | Where will people keep the company repo, so `IBMI_KIT_POLICY` can point at it? | Leave a placeholder absolute path for each person to replace | `profiles/.env.<partition>`: `IBMI_KIT_POLICY` |
| Q18 | Test identities: real user names or invented ones? | Invented, one per role (`DEV01`, `QA01`), with the real group names | `policy.tests.yaml`: `as.user`, `as.groups`, `as.partition` |
| Q19 | Which harmless read proves a partition answers? | `SELECT CURRENT SERVER FROM SYSIBM.SYSDUMMY1` as the only step | `verbs/smoke.yaml`: `name`, `description`, `tags`, `steps` |

`IBMI_USER` is always the placeholder `YOUR_USER` and `IBMI_PARTITION` is the partition's name;
neither is asked. No question fills `IBMI_PASSWORD`.
