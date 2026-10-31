// The CL command table (design D3): the shipped commands.yaml, its schema, and the merge a policy
// uses for its `command_files` and `commands`. Loading the policy itself is not done here.
import { readFileSync } from "node:fs";
import { LineCounter, parseDocument, visit } from "yaml";
import { z } from "zod";
import { BUILTIN_CLASSES } from "./types.js";

const className = z.string().regex(/^[a-z][a-z0-9_]*$/, "a class is lower case letters, digits and _");
const name = z.string().regex(/^[A-Za-z#$@][A-Za-z0-9#$@_]{0,9}$/, "an IBM i name of at most 10 characters");
const kind = z.enum(["object", "library", "rdb"]);

const paramSchema = z.union([
  kind,
  z.object({ kind, class: className.optional(), partition: z.string().min(1).optional() }).strict(),
]);

export const commandEntrySchema = z
  .object({
    class: className.optional(),
    class_by_param: z
      .object({ param: name, values: z.record(z.string().min(1), className), default: className })
      .strict()
      .optional(),
    library: name.optional(), // the product library the command must be qualified to
    positional: z.array(name).optional(), // keyword order for values given without a keyword
    params: z.record(name, paramSchema).optional(), // parameters naming an object, library or RDB
    writes: z.array(name).optional(), // object parameters that are written when given
    nested_sql: name.optional(), // the parameter holding an SQL statement (RUNSQL SQL)
    reason: z.string().optional(), // shown with a danger class
  })
  .strict()
  .refine((e) => Boolean(e.class) !== Boolean(e.class_by_param), { message: "give exactly one of class and class_by_param" });

export const commandTableSchema = z.record(name, commandEntrySchema);
export const commandFileSchema = z.object({ commands: commandTableSchema }).strict();

export type CommandEntry = z.infer<typeof commandEntrySchema>;
export type CommandTable = Record<string, CommandEntry>;
export interface ParamSpec {
  kind: "object" | "library" | "rdb";
  class?: string;
  partition?: string;
}

// Names are case-insensitive on IBM i; store them upper case so lookups need no care.
function normalise(table: CommandTable): CommandTable {
  const out: CommandTable = {};
  for (const [cmd, e] of Object.entries(table)) {
    const up = (s: string) => s.toUpperCase();
    const n: CommandEntry = { ...e };
    if (e.library) n.library = up(e.library);
    if (e.positional) n.positional = e.positional.map(up);
    if (e.writes) n.writes = e.writes.map(up);
    if (e.nested_sql) n.nested_sql = up(e.nested_sql);
    if (e.params) n.params = Object.fromEntries(Object.entries(e.params).map(([k, v]) => [up(k), v]));
    if (e.class_by_param)
      n.class_by_param = {
        ...e.class_by_param,
        param: up(e.class_by_param.param),
        values: Object.fromEntries(Object.entries(e.class_by_param.values).map(([k, v]) => [up(k), v])),
      };
    out[up(cmd)] = n;
  }
  return out;
}

// Parse a commands-only YAML file (the shipped table, or a policy's command_files entry). Every
// error names `source`, so a mistake in a vendor's file points at that file.
export function parseCommandFile(text: string, source: string): CommandTable {
  const r = commandFileSchema.safeParse(parseYaml(text, source));
  if (!r.success) throw new Error(issueLines(source, r.error));
  return normalise(r.data.commands);
}

// YAML 1.2 core schema (so NO stays a string), unique keys, and no aliases: guard files have no
// use for anchors, and an unquoted *LIBL or *ALL is read as one. Errors name `source` and the line.
export function parseYaml(text: string, source: string): unknown {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { schema: "core", uniqueKeys: true, prettyErrors: true, lineCounter });
  const err = doc.errors[0];
  if (err) {
    const where = err.linePos ? ` line ${err.linePos[0].line}` : "";
    throw new Error(`${source}${where}: ${err.message.split("\n")[0]}`);
  }
  visit(doc, {
    Alias(_, node) {
      const line = node.range ? ` line ${lineCounter.linePos(node.range[0]).line}` : "";
      throw new Error(`${source}${line}: *${node.source} is read as a YAML alias; quote values starting with * ("*${node.source}")`);
    },
  });
  return doc.toJS();
}

// zod issues as one line each, naming `source` and the key path.
export function issueLines(source: string, error: z.ZodError): string {
  return error.issues.map((i) => `${source}: ${i.path.join(".") || "(top)"}: ${i.message}`).join("\n");
}

// Later tables win, a whole entry at a time: an override restates the command.
export function mergeCommands(...tables: CommandTable[]): CommandTable {
  const out: CommandTable = {};
  for (const t of tables) Object.assign(out, normalise(t));
  return out;
}

// Classes a table uses that the kit does not define: the custom classes rules may name.
export function customClasses(table: CommandTable): string[] {
  const known = new Set<string>(BUILTIN_CLASSES);
  const found = new Set<string>();
  const add = (c: string | undefined) => { if (c && !known.has(c)) found.add(c); };
  for (const e of Object.values(table)) {
    add(e.class);
    if (e.class_by_param) { Object.values(e.class_by_param.values).forEach(add); add(e.class_by_param.default); }
    for (const p of Object.values(e.params ?? {})) if (typeof p !== "string") add(p.class);
  }
  return [...found].sort();
}

// Each parameter of an entry that names something, with `writes` folded in.
export function paramSpecs(e: CommandEntry): Map<string, ParamSpec> {
  const m = new Map<string, ParamSpec>();
  for (const [k, v] of Object.entries(e.params ?? {})) m.set(k, typeof v === "string" ? { kind: v } : v);
  for (const w of e.writes ?? []) m.set(w, { kind: "object", class: "write" });
  return m;
}

let shipped: CommandTable | undefined;
let shippedText: string | undefined;
// The commands.yaml next to this file (copied into dist by the build).
export function builtinCommands(): CommandTable {
  if (!shipped) shipped = parseCommandFile(builtinCommandsText(), "commands.yaml");
  return shipped;
}

// Its text, for the policy hash.
export function builtinCommandsText(): string {
  return (shippedText ??= readFileSync(new URL("./commands.yaml", import.meta.url), "utf8"));
}
