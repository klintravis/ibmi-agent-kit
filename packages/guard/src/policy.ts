// The execution policy (design D4): one YAML file, loaded once at startup. Loading validates the
// shape strictly, merges the command tables, and leaves a normalised `Policy` that matching and
// `decide` read without further checks.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { BUILTIN_CLASSES } from "./types.js";
import { builtinCommands, commandTableSchema, customClasses, issueLines, mergeCommands, parseCommandFile, parseYaml, type CommandTable } from "./commands.js";

export type Mode = "observe" | "enforce";
export type Verdict = "allow" | "confirm" | "deny";

export interface Rule {
  // undefined = any (the key omitted or written `any`)
  roles?: string[];
  partition?: string[];
  env?: string[];
  classes?: string[];
  decision: Verdict;
}

export interface Policy {
  source: string; // the policy file, or "built-in"
  mode: { default: Mode; partitions: Record<string, Mode> };
  partitions: { name: string; systems: string[]; rdbs: string[] }[];
  unknownPartition?: string;
  environments: { name: string; libraries: string[]; match: string[]; partitions?: string[] }[];
  roles: { name: string; groups: string[]; authlists: string[]; users: string[] }[];
  defaultRole?: string;
  rules: Rule[];
  commands: CommandTable; // shipped table, then command_files in order, then the policy's commands
  rdbs: Record<string, string>; // RDB name → partition, for classify()
  warnings: string[];
}

const mode = z.enum(["observe", "enforce"]);
const word = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "a name is letters, digits, _ and -");
const sysName = z.string().regex(/^[A-Za-z#$@][A-Za-z0-9#$@_]{0,9}$/, "an IBM i name of at most 10 characters");
// A library or user pattern: name characters, * and ${USER}.
const pattern = z.string().regex(/^(?:[A-Za-z0-9#$@_*]|\$\{USER\})+$/, 'name characters, * and ${USER}; quote patterns ("Q*")');
const names = <T extends z.ZodTypeAny>(s: T) => z.array(s).min(1);
// A rule key: `any`, one value, or a list.
const ruleKey = z.union([word, names(word)]).optional();

const policySchema = z
  .object({
    version: z.literal(1),
    mode: z.union([mode, z.record(word, mode)]).optional(),
    partitions: z
      .array(
        z
          .object({ name: word, systems: names(sysName).optional(), rdbs: names(z.string().regex(/^[A-Za-z0-9#$@_]{1,18}$/, "an RDB name")).optional() })
          .strict()
          .refine((p) => p.systems || p.rdbs, { message: "list systems, rdbs or both" }),
      )
      .optional(),
    unknown_partition: word.optional(),
    command_files: z.array(z.string().min(1)).optional(),
    commands: commandTableSchema.optional(),
    environments: z
      .array(
        z
          .object({ name: word, libraries: names(sysName).optional(), match: names(pattern).optional(), partitions: names(word).optional() })
          .strict()
          .refine((e) => e.libraries || e.match, { message: "list libraries, match or both" }),
      )
      .optional(),
    roles: z
      .array(
        z
          .object({ name: word, groups: names(sysName).optional(), authlists: names(sysName).optional(), users: names(pattern).optional() })
          .strict()
          .refine((r) => r.groups || r.authlists || r.users, { message: "list groups, authlists or users" }),
      )
      .optional(),
    default_role: word.optional(),
    rules: z.array(
      z
        .object({ roles: ruleKey, partition: ruleKey, env: ruleKey, classes: ruleKey, decision: z.enum(["allow", "confirm", "deny"]) })
        .strict(),
    ),
  })
  .strict();

const up = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toUpperCase());
const key = (v: string | string[] | undefined) => (v === undefined || v === "any" ? undefined : typeof v === "string" ? [v] : v);

// Parse policy text. `file` names the policy in every error and anchors `command_files`.
export function parsePolicy(text: string, file: string): Policy {
  const r = policySchema.safeParse(parseYaml(text, file));
  if (!r.success) throw new Error(issueLines(file, r.error));
  const p = r.data;

  const shipped = builtinCommands();
  const tables: CommandTable[] = [shipped];
  const overrides: string[] = [];
  for (const f of p.command_files ?? []) {
    const path = resolve(dirname(file), f);
    const rel = relative(dirname(resolve(file)), path);
    if (isAbsolute(f) || !rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${file}: command_files: ${f} must be a relative path inside the policy's folder`);
    if (!existsSync(path)) throw new Error(`${file}: command_files: ${path} not found`);
    const table = parseCommandFile(readFileSync(path, "utf8"), path);
    for (const cmd of Object.keys(table)) if (shipped[cmd]?.class === "danger") overrides.push(`${f} overrides ${cmd}, which the shipped table classes danger`);
    tables.push(table);
  }
  if (p.commands) tables.push(p.commands);

  const partitions = (p.partitions ?? []).map((x) => ({ name: x.name, systems: up(x.systems), rdbs: up(x.rdbs) }));
  const rdbs: Record<string, string> = {};
  for (const x of partitions) for (const rdb of x.rdbs) rdbs[rdb] = x.name;
  const m = p.mode ?? "enforce";
  const { default: dflt, ...byPartition } = typeof m === "string" ? { default: m } : m;

  const policy: Policy = {
    source: file,
    mode: { default: dflt ?? "enforce", partitions: byPartition },
    partitions,
    environments: (p.environments ?? []).map((e) => {
      const env: Policy["environments"][number] = { name: e.name, libraries: up(e.libraries), match: up(e.match) };
      if (e.partitions) env.partitions = e.partitions;
      return env;
    }),
    roles: (p.roles ?? []).map((x) => ({ name: x.name, groups: up(x.groups), authlists: up(x.authlists), users: up(x.users) })),
    rules: p.rules.map((x) => {
      const rule: Rule = { decision: x.decision };
      for (const k of ["roles", "partition", "env", "classes"] as const) {
        const v = key(x[k]);
        if (v) rule[k] = v;
      }
      return rule;
    }),
    commands: mergeCommands(...tables),
    rdbs,
    warnings: [],
  };
  if (p.unknown_partition) policy.unknownPartition = p.unknown_partition;
  if (p.default_role) policy.defaultRole = p.default_role;
  const errors = references(policy);
  if (errors.length) throw new Error(errors.map((e) => `${file}: ${e}`).join("\n"));
  policy.warnings = [...overrides, ...shadows(policy)].map((w) => `${file}: ${w}`);
  return policy;
}

// Environment names rules may use without defining them.
const RESERVED_ENVS = ["unmatched", "unqualified"];

// Every name a policy uses must be defined; returns the errors.
function references(p: Policy): string[] {
  const errors: string[] = [];
  const set = (kind: string, list: { name: string }[]) => {
    const s = new Set<string>();
    for (const { name } of list) {
      if (name === "any") errors.push(`${kind} "any" is reserved: it means anything in a rule`);
      if (s.has(name)) errors.push(`${kind} ${name} is defined twice`);
      s.add(name);
    }
    return s;
  };
  const partitions = set("partition", p.partitions);
  const envs = set("environment", p.environments);
  const roles = set("role", p.roles);
  for (const r of RESERVED_ENVS) if (envs.has(r)) errors.push(`environment ${r} is reserved: it is what the guard calls ${r === "unmatched" ? "a library no entry matches" : "an unqualified read or call"}`);
  for (const r of RESERVED_ENVS) envs.add(r);
  const classes = new Set<string>([...BUILTIN_CLASSES, ...customClasses(p.commands)]);
  const need = (what: string, kind: string, known: Set<string>, names: string[] | undefined) => {
    for (const n of names ?? []) if (!known.has(n)) errors.push(`${what}: ${kind} ${n} is not defined`);
  };

  const seen = new Map<string, string>(); // SYSTEM:X / RDB:X → partition
  for (const x of p.partitions)
    for (const [kind, list] of [["system", x.systems], ["RDB", x.rdbs]] as const)
      for (const n of list) {
        const other = seen.get(`${kind}:${n}`);
        if (other && other !== x.name) errors.push(`${kind} ${n} is listed by partitions ${other} and ${x.name}`);
        seen.set(`${kind}:${n}`, x.name);
      }
  if (p.partitions.length && !p.unknownPartition) errors.push("unknown_partition is required when partitions are listed: it decides a box no partition names");
  need("unknown_partition", "partition", partitions, p.unknownPartition ? [p.unknownPartition] : []);
  need("mode", "partition", partitions, Object.keys(p.mode.partitions));
  need("default_role", "role", roles, p.defaultRole ? [p.defaultRole] : []);
  for (const e of p.environments) need(`environment ${e.name}`, "partition", partitions, e.partitions);
  for (const [cmd, e] of Object.entries(p.commands))
    for (const v of Object.values(e.params ?? {})) if (typeof v !== "string") need(`command ${cmd}`, "partition", partitions, v.partition ? [v.partition] : []);
  p.rules.forEach((r, i) => {
    const what = `rule ${i + 1}`;
    need(what, "role", roles, r.roles);
    need(what, "partition", partitions, r.partition);
    need(what, "env", envs, r.env);
    if (r.classes?.includes("unqualified")) errors.push(`${what}: class unqualified can never be matched: no rule decides an unqualified change`);
    need(what, "class", classes, r.classes?.filter((c) => c !== "unqualified"));
  });
  return errors;
}

// Literal-prefix coverage only, so a warning is never wrong: X* covers XY and XY*; * covers all.
// Anything holding ${USER} is left alone.
function covers(q: string, x: string): boolean {
  if (q.includes("${USER}") || x.includes("${USER}")) return false;
  if (q === x) return true;
  const star = q.indexOf("*");
  return star === q.length - 1 && x.startsWith(q.slice(0, -1));
}

// A list key that is absent means everything: absent covers all, a list covers its subsets.
function within(earlier: string[] | undefined, later: string[] | undefined): boolean {
  return !earlier || (!!later && later.every((x) => earlier.includes(x)));
}

// Environment entries, exact names and rules an earlier entry or rule always wins over.
function shadows(p: Policy): string[] {
  const warnings: string[] = [];
  p.environments.forEach((e, j) => {
    const earlier = p.environments.slice(0, j).filter((d) => within(d.partitions, e.partitions));
    const by = (x: string) => earlier.find((d) => [...d.libraries, ...d.match].some((q) => covers(q, x)));
    const whole = earlier.find((d) => [...e.libraries, ...e.match].every((x) => [...d.libraries, ...d.match].some((q) => covers(q, x))));
    if (whole) warnings.push(`environment ${e.name} can never match: environment ${whole.name} comes first and covers it`);
    else
      for (const lib of e.libraries) {
        const d = by(lib);
        if (d) warnings.push(`environment ${e.name}: ${lib} can never match: environment ${d.name} comes first and covers it`);
      }
  });
  p.rules.forEach((r, j) => {
    const i = p.rules.slice(0, j).findIndex((q) => within(q.roles, r.roles) && within(q.partition, r.partition) && within(q.env, r.env) && within(q.classes, r.classes));
    if (i >= 0) warnings.push(`rule ${j + 1} can never match: rule ${i + 1} comes first and matches everything it does`);
  });
  return warnings;
}

// Read the policy file once at startup; with no path, the built-in policy.
export function loadPolicy(path?: string): Policy {
  if (path === undefined) return builtinPolicy();
  if (!existsSync(path)) throw new Error(`policy file not found: ${path}`);
  return parsePolicy(readFileSync(path, "utf8"), path);
}

// No policy file: observe everything, so installing the guard changes nothing but the log. Danger
// and unqualified operations are still denied, as observe mode always does.
export const BUILTIN_POLICY = `version: 1
mode: observe
rules:
  - { decision: allow }
`;

export function builtinPolicy(): Policy {
  return parsePolicy(BUILTIN_POLICY, "built-in");
}
