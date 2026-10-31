// Verbs (project-verbs design D1, D4): one YAML file each, loaded once at startup from three
// layers. Loading validates the shape and every parameter reference; `bindArgs` and `substitute`
// turn a verb's templates into statement text plus bound values. Running a verb is the server's.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { issueLines, parseYaml } from "./commands.js";

export type Layer = "user" | "proj" | "org";
const LAYERS: Layer[] = ["user", "proj", "org"]; // closest first
// Verbs in one call chain, the top verb included.
export const MAX_VERB_DEPTH = 5;

const NAME = "[A-Za-z][A-Za-z0-9_-]*";
const word = z.string().regex(new RegExp(`^${NAME}$`), "a name is letters, digits, _ and -");
const paramName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a parameter name is letters, digits and _");
const REF = new RegExp(`^(?:(user|proj|org):)?(${NAME})$`);
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const text = z.string().min(1);

const paramSchema = z
  .object({
    type: z.enum(["string", "integer", "decimal", "date", "boolean"]),
    required: z.boolean().optional(),
    default: scalar.optional(),
    allowed: z.array(scalar).min(1).optional(),
  })
  .strict();

const oneOf = (keys: string[]) => (o: Record<string, unknown>, ctx: z.RefinementCtx) => {
  if (keys.filter((k) => o[k] !== undefined).length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `give exactly one of ${keys.join(", ")}` });
};

const setupSchema = z
  .object({ id: word.optional(), requires_absent: text.optional(), sql: text.optional(), cl: text.optional() })
  .strict()
  .superRefine(oneOf(["sql", "cl"]));
const expectSchema = z
  .object({
    sql: text,
    equals: z.record(z.string(), z.union([scalar, z.null()])).optional(),
    rows: z.number().int().min(0).optional(),
    empty: z.literal(true).optional(),
  })
  .strict()
  .superRefine(oneOf(["equals", "rows", "empty"]));
const stepSchema = z
  .object({
    sql: text.optional(),
    cl: text.optional(),
    expect: expectSchema.optional(),
    verb: z.string().regex(REF, "a verb is NAME, user:NAME, proj:NAME or org:NAME").optional(),
    args: z.record(paramName, scalar).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    oneOf(["sql", "cl", "expect", "verb"])(s, ctx);
    if (s.args && !s.verb) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "args go with verb" });
  });
const cleanupSchema = z
  .object({ undoes: word, sql: text.optional(), cl: text.optional() })
  .strict()
  .superRefine(oneOf(["sql", "cl"]));

const verbSchema = z
  .object({
    name: word,
    description: text,
    tags: z.array(word).optional(),
    params: z.record(paramName, paramSchema).optional(),
    setup: z.array(setupSchema).optional(),
    steps: z.array(stepSchema).min(1),
    cleanup: z.array(cleanupSchema).optional(),
  })
  .strict();

export type VerbParam = z.infer<typeof paramSchema>;
export type SetupStep = z.infer<typeof setupSchema>;
export type VerbStep = z.infer<typeof stepSchema>;
export type CleanupStep = z.infer<typeof cleanupSchema>;

export interface Verb {
  address: string; // layer:NAME
  name: string; // upper cased
  layer: Layer;
  file: string;
  description: string;
  tags: string[];
  params: Record<string, VerbParam>;
  setup: SetupStep[];
  steps: VerbStep[];
  cleanup: CleanupStep[];
  overridden: boolean; // a closer layer has the same name, so a bare name never reaches this one
}

export interface VerbSet {
  verbs: Verb[]; // loaded, in address order
  refused: string[]; // addresses refused at load; a bare name stops at one rather than fall through
  errors: string[];
}

export type Value = string | number | boolean;
export type Values = Record<string, Value>;

// --- parameter values ---

const EXPECTED = { string: "a string", integer: "an integer", decimal: "a decimal number", date: "a date (YYYY-MM-DD)", boolean: "true or false" };
const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// `v` as a value of `type`, normalised (decimals stay strings, so no digit is lost); undefined if
// it is not one. Nothing typed here can hold a quote, a blank or a comment.
function typed(type: VerbParam["type"], v: unknown): Value | undefined {
  switch (type) {
    case "string":
      return typeof v === "string" ? v : undefined;
    case "boolean":
      return typeof v === "boolean" ? v : undefined;
    case "integer": {
      const n = typeof v === "string" && /^[+-]?\d+$/.test(v) ? Number(v) : v;
      return typeof n === "number" && Number.isSafeInteger(n) ? n : undefined;
    }
    case "decimal":
      if (typeof v === "number") return Number.isFinite(v) && !/e/i.test(String(v)) ? String(v) : undefined;
      return typeof v === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(v) ? v : undefined;
    case "date": {
      const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
      return m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === v ? v : undefined;
    }
  }
}

function valueOf(p: VerbParam, v: unknown): { value: Value } | { error: string } {
  const value = typed(p.type, v);
  if (value === undefined) return { error: `${show(v)} is not ${EXPECTED[p.type]}` };
  if (p.allowed && !p.allowed.some((a) => typed(p.type, a) === value)) return { error: `${show(v)} is not one of ${p.allowed.join(", ")}` };
  return { value };
}

// Validate a call's arguments against the verb's parameters, defaults filled in. Every parameter
// needs a value: an unset one would bind NULL, and `= NULL` matches nothing, so a requires_absent
// check would pass. Throws naming every problem.
export function bindArgs(verb: Pick<Verb, "address" | "params">, args: Record<string, unknown> = {}): Values {
  const errors: string[] = [];
  const values: Values = {};
  for (const k of Object.keys(args)) if (!has(verb.params, k)) errors.push(`${k} is not a parameter`);
  for (const [k, p] of Object.entries(verb.params)) {
    const v = has(args, k) && args[k] !== undefined ? args[k] : p.default;
    if (v === undefined) {
      errors.push(`${k} has no value and no default`);
      continue;
    }
    const r = valueOf(p, v);
    if ("error" in r) errors.push(`${k}: ${r.error}`);
    else values[k] = r.value;
  }
  if (errors.length) throw new Error(`${verb.address}: ${errors.join("; ")}`);
  return values;
}

// --- templates ---

// "arg" is a nested verb's argument value: plain text, so only `${}` applies.
export type TemplateKind = "sql" | "cl" | "arg";
type Ctx = "code" | "'" | '"' | "comment";
interface Ref {
  start: number;
  end: number;
  sigil: "$" | ":" | "?";
  name?: string; // undefined for ? and a malformed ${
  ctx: Ctx;
}

const DOLLAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/y;
const COLON = /:([A-Za-z_][A-Za-z0-9_]*)/y;

// Every `${name}`, and in code `:name` and (SQL) `?`, with what it falls in: code, a '' literal,
// a "" name or a comment. Mirrors the lexer: SQL has -- and /* */ comments and "" names; CL has
// /* */ comments (LIB/*ALL is not one) and '' values only.
function refs(t: string, kind: TemplateKind): Ref[] {
  const out: Ref[] = [];
  const sql = kind === "sql";
  let ctx: Ctx = "code";
  let close = "";
  for (let i = 0; i < t.length; ) {
    const c = t[i];
    const two = t.slice(i, i + 2);
    if (kind !== "arg") {
      if (ctx === "code") {
        if (sql && two === "--") { ctx = "comment"; close = "\n"; i += 2; continue; }
        if (two === "/*" && (sql || !(/[\w#$@}]/.test(t[i - 1] ?? "") && /[A-Za-z]/.test(t[i + 2] ?? "")))) { ctx = "comment"; close = "*/"; i += 2; continue; }
        if (c === "'" || (sql && c === '"')) { ctx = c; i++; continue; }
      } else if (ctx === "comment") {
        if (t.startsWith(close, i)) { ctx = "code"; i += close.length; continue; }
      } else if (c === ctx) {
        if (t[i + 1] === ctx) { i += 2; continue; } // a doubled quote stays inside
        ctx = "code";
        i++;
        continue;
      }
    }
    if (two === "${") {
      DOLLAR.lastIndex = i;
      const m = DOLLAR.exec(t);
      const end = m ? i + m[0].length : i + 2;
      out.push({ start: i, end, sigil: "$", name: m?.[1], ctx });
      i = end;
      continue;
    }
    if (kind !== "arg" && ctx === "code" && c === ":") {
      COLON.lastIndex = i;
      const m = COLON.exec(t);
      if (m) {
        out.push({ start: i, end: i + m[0].length, sigil: ":", name: m[1], ctx });
        i += m[0].length;
        continue;
      }
    }
    if (sql && ctx === "code" && c === "?") out.push({ start: i, end: i + 1, sigil: "?", ctx });
    i++;
  }
  return out;
}

// What makes a template unsafe or wrong, one line each, given the verb's parameters.
function templateErrors(t: string, kind: TemplateKind, params: Record<string, VerbParam>): string[] {
  const errors: string[] = [];
  for (const r of refs(t, kind)) {
    const p = r.name !== undefined && has(params, r.name) ? params[r.name] : undefined;
    const ref = `\${${r.name}}`;
    if (r.sigil === "?") errors.push("a ? marker: write :name so the value is bound");
    else if (r.sigil === ":") {
      if (kind === "sql" && !p) errors.push(`:${r.name} is not a parameter`);
      if (kind === "cl" && p) errors.push(`:${r.name}: CL has no bound values; write '${ref}'`);
    } else if (r.name === undefined) errors.push("${ must be ${name}");
    else if (!p) errors.push(`${ref} is not a parameter`);
    else if (r.ctx === "comment") errors.push(`${ref} is inside a comment`);
    else if (p.type === "string" && !p.allowed) errors.push(`${ref}: parameter ${r.name} is a string with no allowed list, so it would be free text${kind === "sql" ? `; use :${r.name}` : ""}`);
    else if (kind === "sql" && r.ctx === "code" && p.type === "date") errors.push(`${ref} is a date outside quotes, which SQL reads as arithmetic; write '${ref}'`);
    else if (kind !== "arg" && r.ctx === "code" && p.allowed?.some((a) => /['"]/.test(String(a)))) errors.push(`${ref} is outside quotes and an allowed value holds a quote`);
  }
  return errors;
}

export interface Substituted {
  text: string;
  params: Value[]; // one per ? marker, in order
}

// A template with `values` in: SQL `:p` becomes a ? marker with the value bound, `${p}` becomes
// text (quotes doubled inside a literal). Refuses what loading refuses, so it is safe on its own.
export function substitute(t: string, kind: TemplateKind, params: Record<string, VerbParam>, values: Values): Substituted {
  const errors = templateErrors(t, kind, params);
  if (errors.length) throw new Error(errors.join("; "));
  let out = "";
  let at = 0;
  const bound: Value[] = [];
  for (const r of refs(t, kind)) {
    if (r.sigil === ":" && kind === "cl") continue; // not a parameter: CL text as written
    const name = r.name as string;
    if (!has(values, name)) throw new Error(`parameter ${name} has no value`);
    const v = values[name];
    out += t.slice(at, r.start);
    at = r.end;
    if (r.sigil === ":") {
      out += "?";
      bound.push(v);
      continue;
    }
    let s = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
    if (r.ctx === "'" || r.ctx === '"') s = s.split(r.ctx).join(r.ctx + r.ctx);
    else if (kind !== "arg") {
      if (/['"]/.test(s)) throw new Error(`\${${name}}: ${show(s)} holds a quote outside quotes`);
      // 1 -${n} with n = -1 would make --1, a comment that hides the rest of the line
      if (kind === "sql" && /--|\/\*/.test(out.slice(-1) + s + t.slice(at, at + 1))) throw new Error(`\${${name}}: ${show(s)} would start a comment`);
    }
    out += s;
  }
  return { text: out + t.slice(at), params: bound };
}

// --- loading ---

export interface VerbSources {
  home: string; // user layer: <home>/.ibmi-agent-kit/verbs
  cwd: string; // proj layer: <cwd>/.ibmi-kit/verbs
  extra?: string; // proj layer: IBMI_KIT_VERBS, folders joined with the path delimiter
  policyFile?: string; // org layer: verbs/ beside it
}

// One file: the verb, and why it is refused (empty if it is not). Throws if the shape is wrong.
function parseVerb(source: string, file: string, layer: Layer): { verb: Verb; errors: string[] } {
  const r = verbSchema.safeParse(parseYaml(source, file));
  if (!r.success) throw new Error(issueLines(file, r.error));
  const v = r.data;
  const params = v.params ?? {};
  const errors: string[] = [];
  const check = (where: string, t: string | undefined, kind: TemplateKind) => {
    if (t !== undefined) for (const e of templateErrors(t, kind, params)) errors.push(`${where}: ${e}`);
  };
  const statement = (where: string, s: { sql?: string; cl?: string }) => {
    check(`${where}.sql`, s.sql, "sql");
    check(`${where}.cl`, s.cl, "cl");
  };
  for (const [k, p] of Object.entries(params)) {
    p.allowed?.forEach((a, i) => { if (typed(p.type, a) === undefined) errors.push(`params.${k}.allowed.${i}: ${show(a)} is not ${EXPECTED[p.type]}`); });
    if (p.default !== undefined) {
      const d = valueOf(p, p.default);
      if ("error" in d) errors.push(`params.${k}.default: ${d.error}`);
    }
  }
  const ids = new Set<string>();
  (v.setup ?? []).forEach((s, i) => {
    if (s.id !== undefined) {
      if (ids.has(s.id)) errors.push(`setup.${i}.id: ${s.id} is used twice`);
      ids.add(s.id);
    }
    check(`setup.${i}.requires_absent`, s.requires_absent, "sql");
    statement(`setup.${i}`, s);
  });
  v.steps.forEach((s, i) => {
    statement(`steps.${i}`, s);
    check(`steps.${i}.expect.sql`, s.expect?.sql, "sql");
    for (const [k, a] of Object.entries(s.args ?? {})) if (typeof a === "string") check(`steps.${i}.args.${k}`, a, "arg");
  });
  (v.cleanup ?? []).forEach((s, i) => {
    if (!ids.has(s.undoes)) errors.push(`cleanup.${i}.undoes: no setup step has id ${s.undoes}`);
    statement(`cleanup.${i}`, s);
  });
  const name = v.name.toUpperCase();
  const verb: Verb = { address: `${layer}:${name}`, name, layer, file, description: v.description, tags: v.tags ?? [], params, setup: v.setup ?? [], steps: v.steps, cleanup: v.cleanup ?? [], overridden: false };
  return { verb, errors: errors.map((e) => `${file}: ${e}`) };
}

function find(verbs: Verb[], refused: Set<string>, ref: string): Verb {
  const m = REF.exec(ref);
  if (!m) throw new Error(`${ref} is not a verb address (NAME, user:NAME, proj:NAME or org:NAME)`);
  const name = m[2].toUpperCase();
  for (const layer of m[1] ? [m[1]] : LAYERS) {
    const address = `${layer}:${name}`;
    if (refused.has(address)) throw new Error(`${address} was refused at load`);
    const v = verbs.find((x) => x.address === address);
    if (v) return v;
  }
  throw new Error(`no verb ${ref}`);
}

// A verb by address, or a bare name in the closest layer that has it. Throws if there is none, or
// if the one it would reach was refused at load.
export function resolveVerb(set: VerbSet, ref: string): Verb {
  return find(set.verbs, new Set(set.refused), ref);
}

// Load every verb from the three layers' folders. A missing folder loads nothing, except one named
// in IBMI_KIT_VERBS, which is an error. A refused verb is reported in `errors`; the rest still load.
export function loadVerbs(s: VerbSources): VerbSet {
  const folders: [Layer, string, boolean][] = [
    ["user", join(s.home, ".ibmi-agent-kit", "verbs"), false],
    ["proj", join(s.cwd, ".ibmi-kit", "verbs"), false],
    ...(s.extra ?? "").split(delimiter).filter((d) => d.trim()).map((d): [Layer, string, boolean] => ["proj", resolve(s.cwd, d.trim()), true]),
    ...(s.policyFile ? [["org", join(dirname(s.policyFile), "verbs"), false] as [Layer, string, boolean]] : []),
  ];
  const errors: string[] = [];
  const parsed: { verb: Verb; errors: string[] }[] = [];
  const seen = new Set<string>();
  for (const [layer, dir, named] of folders) {
    if (seen.has(resolve(dir))) continue; // IBMI_KIT_VERBS naming .ibmi-kit/verbs again
    seen.add(resolve(dir));
    if (!existsSync(dir)) {
      if (named) errors.push(`IBMI_KIT_VERBS: ${dir} not found`);
      continue;
    }
    try {
      for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort()) {
        const file = join(dir, f);
        try {
          parsed.push(parseVerb(readFileSync(file, "utf8"), file, layer));
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
    } catch (e) {
      errors.push(`${dir}: ${(e as Error).message}`);
    }
  }

  const refused = new Set<string>();
  let live: Verb[] = [];
  const byAddress = new Map<string, { verb: Verb; errors: string[] }[]>();
  for (const p of parsed) byAddress.set(p.verb.address, [...(byAddress.get(p.verb.address) ?? []), p]);
  for (const [address, ps] of byAddress) {
    if (ps.length > 1) errors.push(`${address} is declared by ${ps.map((p) => p.verb.file).join(" and ")}; none of them loads`);
    else errors.push(...ps[0].errors);
    if (ps.length > 1 || ps[0].errors.length) refused.add(address);
    else live.push(ps[0].verb);
  }
  const refuse = (v: Verb, why: string) => {
    errors.push(`${v.file}: ${why}`);
    refused.add(v.address);
    live = live.filter((x) => x !== v);
  };
  const callee = (s: VerbStep) => find(live, refused, s.verb as string);

  // A call must reach a loaded verb with the parameters it gives and needs; repeat, since refusing
  // one verb refuses its callers. Then refuse cycles, and repeat both until there are none.
  for (;;) {
    for (let changed = true; changed; ) {
      changed = false;
      for (const v of [...live]) {
        const why = v.steps.map((s, i) => (s.verb ? callProblem(s, i) : undefined)).find((w) => w);
        if (why) {
          refuse(v, why);
          changed = true;
        }
      }
    }
    const cycle = findCycle();
    if (!cycle) break;
    const path = cycle.map((v) => v.address).join(" → ");
    for (const v of new Set(cycle)) refuse(v, `${v.address} is in a cycle: ${path}`);
  }
  function callProblem(s: VerbStep, i: number): string | undefined {
    let t: Verb;
    try {
      t = callee(s);
    } catch (e) {
      return `steps.${i}.verb: ${(e as Error).message}`;
    }
    const args = s.args ?? {};
    for (const k of Object.keys(args)) if (!has(t.params, k)) return `steps.${i}.args.${k}: ${t.address} has no parameter ${k}`;
    for (const [k, p] of Object.entries(t.params)) if (p.default === undefined && !has(args, k)) return `steps.${i}: ${t.address} needs ${k}`;
    return undefined;
  }
  function findCycle(): Verb[] | undefined {
    const state = new Map<Verb, "open" | "done">();
    const dfs = (v: Verb, path: Verb[]): Verb[] | undefined => {
      if (state.get(v) === "done") return undefined;
      if (state.get(v) === "open") return [...path.slice(path.indexOf(v)), v];
      state.set(v, "open");
      for (const s of v.steps) {
        const c = s.verb ? dfs(callee(s), [...path, v]) : undefined;
        if (c) return c;
      }
      state.set(v, "done");
      return undefined;
    };
    for (const v of live) {
      const c = dfs(v, []);
      if (c) return c;
    }
    return undefined;
  }

  // Longest call chain from each verb; the graph is acyclic now.
  const chains = new Map<Verb, Verb[]>();
  const chain = (v: Verb): Verb[] => {
    let c = chains.get(v);
    if (!c) {
      c = [v];
      for (const s of v.steps) if (s.verb) { const d = chain(callee(s)); if (d.length + 1 > c.length) c = [v, ...d]; }
      chains.set(v, c);
    }
    return c;
  };
  for (const [v, c] of live.map((v) => [v, chain(v)] as const))
    if (c.length > MAX_VERB_DEPTH) refuse(v, `${v.address} nests more than ${MAX_VERB_DEPTH} verbs deep: ${c.map((x) => x.address).join(" → ")}`);

  for (const v of live) {
    const closer = LAYERS.slice(0, LAYERS.indexOf(v.layer)).map((l) => `${l}:${v.name}`);
    v.overridden = closer.some((a) => refused.has(a) || live.some((x) => x.address === a));
  }
  live.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return { verbs: live, refused: [...refused].sort(), errors };
}
