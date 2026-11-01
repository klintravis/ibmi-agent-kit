## Decisions

- **One type, a fixed pattern.** `name` matches `^[A-Za-z$#@][A-Za-z0-9$#@_.]{0,9}$` and is upper
  cased by `typed`, so `allowed` lists and defaults are validated and compared the same way. No
  user regex: a pattern a verb author writes is a pattern a reviewer must audit.
- **Substitution rules follow `integer`.** The only template check that blocks a string is "no
  `allowed` list"; `name` is exempt from it. A name holds no quote, blank, parenthesis, comma, `&`,
  `-` or `/`, so it cannot end a CL value, start a comment or add a statement, in or out of quotes.
  In SQL `:p` binds it as a string and `${p}` is text, exactly as for the other types.
- **The guard is unchanged.** Verbs are decided on the substituted text (`planVerb`), so a `name`
  that names a library in a command's library slot classifies and resolves to its environment as a
  literal would. A selfcheck proves a deny by an environment rule.
- **`policy test` loads verbs always.** Same `loadVerbs` call as before (project folder and beside
  the policy, never a person's own). Every entry of `errors` is printed as an error and makes the
  exit code 1, the existing "a test case failed" code. Without verb folders `errors` is empty.
- **Mirrors of the type list** are the zod enum, `typed` and `EXPECTED` only; `verb_list` and the run
  log print `p.type` as is, and `policy_check` takes a verb name, not types.
