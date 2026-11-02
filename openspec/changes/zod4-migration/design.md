## Decisions

- Bump to `^4.6.7` everywhere, one dedupe in the lockfile (guard had an exact 3.25.76 pin; now a caret like the others).
- Keep the deprecated-but-working zod 3 spellings; they compile and behave the same, and rewriting them is churn.
- Do not wrap tool input shapes in `.strict()` to bring back `additionalProperties: false`: that would make the server refuse unknown arguments, a behaviour change. The SDK's generated schema is accepted as is.
- Selfcheck: replace only the quoted zod wording, keep each assertion naming the path and key. For `.inf` the schema now stops it before the typed check (zod 4 `z.number()` rejects Infinity), so that row expects `Invalid input`, and a `1e21` row keeps covering the typed check's own message.

## Risks

Clients that rely on `additionalProperties: false` in `tools/list` lose that hint only; no behaviour changes.
