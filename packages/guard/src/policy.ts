// The execution policy (design D4): one YAML file, loaded once at startup. Loading validates the
// shape strictly, merges the command tables, and leaves a normalised `Policy` that matching and
// `decide` read without further checks.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { builtinCommands, commandTableSchema, issueLines, mergeCommands, parseCommandFile, parseYaml, type CommandTable } from "./commands.js";

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

  const tables: CommandTable[] = [builtinCommands()];
  for (const f of p.command_files ?? []) {
    const path = resolve(dirname(file), f);
    if (!existsSync(path)) throw new Error(`${file}: command_files: ${path} not found`);
    tables.push(parseCommandFile(readFileSync(path, "utf8"), path));
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
  return policy;
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
