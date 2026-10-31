// CL classification from the closed command table (design D3). The tokenizer knows exactly enough
// CL to find the command, its qualifier and each parameter's value: KEYWORD(value), positional
// values, nested parentheses, 'quoted' strings with '' escapes, and LIB/OBJ.
import { OPAQUE_RUNNERS } from "./builtins.js";
import { paramSpecs, type ParamSpec } from "./commands.js";
import { stripClComments } from "./lexer.js";
import { danger, objectOp, type Run } from "./run.js";
import type { ObjectRef, OpClass, Operation } from "./types.js";

// Special values that name no object.
const NO_OBJECT = new Set(["*NONE", "*SAME", "*N", "*DFT", "*CRTDFT", "*LDA", "*GDA", "*PDA", "*CURRENT", "*PRV", "*BLANK", "*SRCMBRTXT", "*GEN", "*NOCHK"]);
// RDB values that mean this database.
const LOCAL_RDB = new Set(["*LOCAL", "*NONE", "*CURRENT"]);
const LIBL = new Set(["*LIBL", "*NLVLIBL"]); // qualifiers that search the library list
const IBM_LIBS = new Set(["QSYS", "QSYS2", ...LIBL]);
// Library special values that are never a reference to another parameter (*FROMLIB, *SAVLIB are).
const SPECIAL_LIBS = new Set(["*LIBL", "*CURLIB", "*ALL", "*ALLUSR", "*USRLIBL", "*ALLAVL"]);

// Split at blanks outside quotes and parentheses: `KEY(a b)`, `(a b)` and `'a b'` are one element.
export function splitTop(s: string): { items: string[]; error?: string } {
  const items: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        const k = s.indexOf("'", j);
        if (k < 0) return { items, error: "a quoted value is never closed" };
        if (s[k + 1] === "'") { j = k + 2; continue; }
        j = k + 1;
        break;
      }
      cur += s.slice(i, j);
      i = j - 1;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")" && --depth < 0) return { items, error: "a ) has no matching (" };
    if (/\s/.test(c) && depth === 0) {
      if (cur) items.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (depth > 0) return { items, error: "a ( is never closed" };
  if (cur) items.push(cur);
  return { items };
}

const quoted = (el: string) => el.length >= 2 && el.startsWith("'") && el.endsWith("'");
const unquote = (el: string) => (quoted(el) ? el.slice(1, -1).replace(/''/g, "'") : el);

function outsideQuotes(s: string): string {
  return s.replace(/'(?:[^']|'')*'/g, "''");
}

export interface ClParsed {
  lib?: string;
  name: string;
  params: Map<string, string>; // keyword → raw value inside its parentheses
  positional: string[];
}

export function parseCl(text: string): ClParsed | { error: string } {
  const { items, error } = splitTop(text);
  if (error) return { error };
  if (items.length && /^[A-Za-z#$@][\w#$@]*:$/.test(items[0])) items.shift(); // a label
  const head = items.shift();
  const m = head && /^(?:([^/()']+)\/)?([A-Za-z#$@][A-Za-z0-9#$@_]*)$/.exec(head);
  if (!m) return { error: `"${head ?? ""}" is not a CL command name` };
  const parsed: ClParsed = { name: m[2].toUpperCase(), params: new Map(), positional: [] };
  if (m[1]) parsed.lib = m[1].toUpperCase();
  for (const el of items) {
    const kw = /^([A-Za-z#$@][A-Za-z0-9#$@_]*)\(([\s\S]*)\)$/.exec(el);
    if (kw) parsed.params.set(kw[1].toUpperCase(), kw[2]);
    else parsed.positional.push(el);
  }
  return parsed;
}

// The elements of a parameter value that name something: a list's members; for a parenthesised
// element such as (B/X (1 2)), its first member. Numbers are never names.
function nameElements(value: string): string[] {
  const out: string[] = [];
  for (const el of splitTop(value).items) {
    const first = el.startsWith("(") ? splitTop(el.slice(1, -1)).items[0] : el;
    if (!first || /^[+-]?\d/.test(first)) continue;
    out.push(quoted(first) ? unquote(first).toUpperCase() : first.toUpperCase());
  }
  return out;
}

export function classifyClText(text: string, run: Run): Operation[] {
  const fail = (reason: string, command?: string) => [danger("cl", reason, run, command ? { command } : {})];
  const stripped = stripClComments(text);
  if (stripped.error) return fail(stripped.error);
  const cmd = stripped.text;
  if (!cmd) return fail("an empty CL command");
  const bare = outsideQuotes(cmd);
  if (bare.includes("?")) return fail("prompting (?) lets values be typed later, where the guard does not see them");
  if (bare.includes("&")) return fail("a CL variable (&) is only known when the command runs");
  const parsed = parseCl(cmd);
  if ("error" in parsed) return fail(parsed.error);
  const { name, lib } = parsed;
  const entry = run.commands[name];
  if (!entry) {
    // Only a command found through the library list may be one this table has not met yet; a
    // qualified one is someone's own command, and the qualifier rule decides it.
    if (!lib || LIBL.has(lib)) return [danger("cl", `${name} is not in the command table`, run, { command: name, code: "unknown_command" })];
    if (lib === "QSYS" || lib === "QSYS2") return fail(`${lib}/${name} is not in the command table`, name);
    return fail(`${lib}/${name} is not the IBM command: only QSYS, QSYS2 or the library the command table names may qualify it`, name);
  }
  if (entry.library) {
    if (lib !== entry.library) return fail(`${name} must be qualified to its product library: ${entry.library}/${name}`, name);
  } else if (lib && !IBM_LIBS.has(lib)) {
    return fail(`${lib}/${name} is not the IBM command: only QSYS, QSYS2 or the library the command table names may qualify it`, name);
  }

  // positional values take the keyword order the entry declares
  const params = new Map(parsed.params);
  const order = entry.positional ?? [];
  if (parsed.positional.length > order.length) {
    return fail(`${name} has more positional values than the command table describes; write them as KEYWORD(value)`, name);
  }
  for (const [i, v] of parsed.positional.entries()) {
    if (params.has(order[i])) return fail(`${name} gives ${order[i]} both by position and by keyword`, name);
    params.set(order[i], v);
  }

  let cls: OpClass = entry.class ?? "danger";
  if (entry.class_by_param) {
    const { param, values } = entry.class_by_param;
    const raw = params.get(param);
    const v = raw === undefined ? undefined : unquote(splitTop(raw).items[0] ?? "").toUpperCase();
    cls = (v !== undefined && values[v]) || entry.class_by_param.default;
    if (cls === "danger") {
      return fail(v === undefined ? `${name} without ${param} is not a listed value` : `${name} ${param}(${v}) is not a value the command table lists`, name);
    }
  }
  if (cls === "danger") return fail(entry.reason ?? `${name} is classed danger`, name);

  const base: Partial<Operation> = { command: name };
  if (name === "CALL") {
    const pgm = nameElements(params.get("PGM") ?? "")[0];
    const called = pgm?.split("/").pop();
    if (called && (called === "QCMDEXC" || OPAQUE_RUNNERS.has(called))) return fail(`CALL ${called} runs a command or shell the guard does not see`, name);
  }

  const ops: Operation[] = [];
  const specs = paramSpecs(entry);
  // RDB(...) moves the command to another database: decided there when mapped, danger when not
  let remote: { rdb: string; partition: string } | undefined;
  for (const [param, spec] of specs) {
    if (spec.kind !== "rdb") continue;
    const v = nameElements(params.get(param) ?? "")[0];
    if (!v || LOCAL_RDB.has(v)) continue;
    const partition = run.rdbs[v];
    if (!partition) return fail(`${name} ${param}(${v}): ${v} is another database and no partition lists it in rdbs`, name);
    remote = { rdb: v, partition };
  }

  if (entry.nested_sql) {
    const raw = params.get(entry.nested_sql);
    const items = raw === undefined ? [] : splitTop(raw).items;
    if (items.length !== 1 || !quoted(items[0])) {
      return fail(`${name} ${entry.nested_sql}() must be one quoted literal so the statement can be decided`, name);
    }
    ops.push(...run.nestedSql(unquote(items[0]), name));
  }

  for (const [param, spec] of specs) {
    if (spec.kind === "rdb") continue;
    const raw = params.get(param);
    if (raw === undefined) continue;
    for (const el of nameElements(raw)) {
      const op = elementOp(el, spec, spec.class ?? cls, params, run, base);
      if (op) ops.push(op);
    }
  }
  if (!ops.length) {
    const op: Operation = { class: cls, source: "cl", ...base };
    if (run.via.length) op.via = [...run.via];
    ops.push(op);
  }
  if (remote) {
    for (const op of ops) {
      if (op.class === "danger" || op.source !== "cl") continue;
      op.partition = remote.partition;
      if (op.object) op.object.rdb = remote.rdb;
    }
  }
  return ops;
}

// One named element of a parameter as an operation, or null when it names nothing (*NONE).
function elementOp(el: string, spec: ParamSpec, cls: OpClass, params: Map<string, string>, run: Run, base: Partial<Operation>): Operation | null {
  const extra: Partial<Operation> = { ...base };
  if (spec.partition) extra.partition = spec.partition;
  const parts = el.split("/");
  if (parts.length > 2) return danger("cl", `${el} is not a library-qualified name`, run, base);
  let lib: string | undefined = parts.length === 2 ? parts[0] : spec.kind === "library" ? parts[0] : undefined;
  const name = parts[parts.length - 1];

  // *FROMLIB, *SAVLIB ...: the value of the parameter it names
  if (lib && !SPECIAL_LIBS.has(lib) && lib.startsWith("*") && params.has(lib.slice(1))) lib = nameElements(params.get(lib.slice(1))!)[0];
  if (spec.kind === "object" && parts.length === 1 && name.startsWith("*") && NO_OBJECT.has(name)) return null;
  if (spec.kind === "library" && lib && NO_OBJECT.has(lib)) return null;

  let object: ObjectRef;
  if (!lib || lib === "*LIBL") object = { name };
  else if (lib === "*CURLIB") object = { lib, name }; // resolved to the current library at decision time
  else if (lib.startsWith("*") || lib.includes("*")) {
    // *ALL, *ALLUSR, *USRLIBL or a generic AB*: more than one library
    const op = objectOp(cls, { name: spec.kind === "library" ? lib : `${lib}/${name}` }, "cl", run, extra);
    if (op.class === "unqualified") op.reason = `name one library: ${lib} reaches more than one`;
    return op;
  } else object = { lib, name };
  if (spec.kind === "library") { object.name = object.lib ?? name; object.type = "*LIB"; }
  return objectOp(cls, object, "cl", run, extra);
}
