## Decisions

- Bump to `4.6.7` in guard, which keeps its exact pin (main pinned `3.25.76`), and to `^4.6.7` in screen, server and source, which kept a caret on main; one dedupe in the lockfile.
- Zod 4 loosened three things the guard files relied on; `parseYaml` (the one YAML loader) restores them: a `__proto__` map key is refused (zod 4 drops it unchecked), every explicit tag is refused except the core plain ones and a bare `!` (the object check accepts a Set, Date or Buffer as `{}`; an allowlist fails closed, so an unknown `!foo` is refused too, which is stricter than before), and `issueLines` unfolds zod 4's nested `invalid_key` and `invalid_union` issues so the repo's own key messages print as before.
- Keep the deprecated-but-working zod 3 spellings; they compile and behave the same, and rewriting them is churn.
- Do not wrap tool input shapes in `.strict()` to bring back `additionalProperties: false`: that would make the server refuse unknown arguments, a behaviour change. The SDK's generated schema is accepted as is.
- Selfcheck: replace only the quoted zod wording, keep each assertion naming the path and key. For `.inf` the schema now stops it before the typed check (zod 4 `z.number()` rejects Infinity), so that row expects `Invalid input`, and a `1e21` row keeps covering the typed check's own message.

## Risks

Clients that rely on `additionalProperties: false` in `tools/list` lose that hint only; no behaviour changes.

JSON inputs do not pass `parseYaml`: a `__proto__` key in MCP `args`, or in the `schemas`/`bases` record maps of recorded replay `lookups`, is now dropped by zod 4, where zod 3 also dropped it but first refused a wrong-typed value under it (an object, for `args`). The top level of `lookups` is strict and still refuses the key. No code is added: `bindArgs` takes only declared parameters and a verb cannot declare `__proto__` (YAML), and a replay answer that is dropped is simply never found, so the line is skipped as "never asked". A selfcheck row shows the `policy_check` result for such `args` equals the one without.
