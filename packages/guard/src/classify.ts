// classify(): a script or one CL command → classed operations (design D1). Recognising is
// synchronous and pure; the lookups run afterwards, only for what needs the box: `*CURLIB`, long
// schema names, and the alias or view behind a written object.
import { classifyClText } from "./cl.js";
import { builtinCommands } from "./commands.js";
import { splitScript, stripClComments, type SplitStatement } from "./lexer.js";
import { danger, MAX_DEPTH, type Run, type ScriptState } from "./run.js";
import { classifySqlTokens } from "./sql.js";
import type { Classification, ClassifiedStatement, ClassifyContext, ObjectRef, Operation } from "./types.js";

const SYSTEM_NAME = /^[A-Z#$@][A-Z0-9#$@_]{0,9}$/;
const MAX_BASE_DEPTH = 3;

function newRun(ctx: ClassifyContext, state: ScriptState, via: string[]): Run {
  const rdbs = Object.fromEntries(Object.entries(ctx.rdbs ?? {}).map(([k, v]) => [k.toUpperCase(), v]));
  const run: Run = {
    commands: ctx.commands ?? builtinCommands(),
    rdbs,
    via,
    state,
    nestedSql(text, how) {
      const child = newRun(ctx, state, [...via, how]);
      if (child.via.length > MAX_DEPTH) return [danger("sql", `commands nested more than ${MAX_DEPTH} deep are not classified`, child)];
      return splitScript(text).flatMap((s) => statementOps(s, child).operations);
    },
    nestedCl(text, how) {
      const child = newRun(ctx, state, [...via, how]);
      if (child.via.length > MAX_DEPTH) return [danger("cl", `commands nested more than ${MAX_DEPTH} deep are not classified`, child)];
      return classifyClText(text, child);
    },
  };
  return run;
}

function statementOps(s: SplitStatement, run: Run): { operations: Operation[]; createdView?: string[] } {
  if (s.error) return { operations: [danger(s.kind, `could not parse: ${s.error}`, run)] };
  if (s.kind === "cl") {
    // A CL line inside RUNSQL or QCMDEXC text is not something either runs.
    if (run.via.length) return { operations: [danger("cl", "a CL: line inside nested SQL is not classified", run)] };
    return { operations: classifyClText(s.text, run) };
  }
  return classifySqlTokens(s.tokens, run);
}

const key = (o: { lib?: string; name: string }) => `${o.lib}.${o.name}`;

class Resolver {
  private schemas = new Map<string, Promise<string | undefined>>();
  private curlib?: Promise<string | undefined>;
  curlibChanged = false; // an earlier statement holds a liblist operation
  constructor(private ctx: ClassifyContext, private local: Map<string, ObjectRef[]>, readonly notes: string[]) {}

  private async currentLibrary(): Promise<string | undefined> {
    this.curlib ??= this.ctx.lookups.currentLibrary().catch((e) => {
      this.notes.push(`current library lookup failed: ${(e as Error).message}`);
      return undefined;
    });
    return this.curlib;
  }

  private async systemSchema(schema: string): Promise<string | undefined> {
    let p = this.schemas.get(schema);
    if (!p) {
      p = this.ctx.lookups.systemSchema(schema).then(
        (s) => {
          if (!s) this.notes.push(`no system name found for schema ${schema}`);
          return s?.toUpperCase();
        },
        (e) => {
          this.notes.push(`system name lookup for schema ${schema} failed: ${(e as Error).message}`);
          return undefined;
        },
      );
      this.schemas.set(schema, p);
    }
    return p;
  }

  // *CURLIB and long schema names, in place. Returns the op (possibly re-classed).
  async names(op: Operation): Promise<Operation> {
    const o = op.object;
    if (!o?.lib || o.rdb) return op;
    if (o.lib === "*CURLIB") {
      // After a library list change in the script, the box's answer is about the wrong moment.
      const lib = this.curlibChanged ? undefined : (await this.currentLibrary())?.toUpperCase();
      if (!lib) {
        const name = o.type === "*LIB" ? "*CURLIB" : o.name;
        const r: Operation = { ...op, object: { name } };
        if (op.class === "read" || op.class === "call") r.env = "unqualified";
        else if (op.class !== "danger") {
          r.class = "unqualified";
          r.reason = this.curlibChanged ? "the script changes the current library; name the library" : "*CURLIB could not be resolved to the job's current library; name the library";
        }
        return r;
      }
      o.lib = lib;
      if (o.type === "*LIB") o.name = lib;
    } else if (!SYSTEM_NAME.test(o.lib)) {
      const sys = await this.systemSchema(o.lib);
      if (sys) {
        o.schema = o.lib;
        o.lib = sys;
        if (o.type === "*LIB") o.name = sys;
      }
    }
    return op;
  }

  // Writes through an alias or view also write each base table: those the script created itself,
  // then what the box says.
  async bases(op: Operation, rawKey: string, depth = 0): Promise<Operation[]> {
    const o = op.object;
    if (op.class !== "write" || !o?.lib || o.rdb || o.type || depth >= MAX_BASE_DEPTH) return [];
    const found: ObjectRef[] = [...(this.local.get(rawKey) ?? []), ...(this.local.get(key(o)) ?? [])];
    try {
      for (const b of await this.ctx.lookups.baseTables({ lib: o.lib, name: o.name })) found.push({ lib: b.lib.toUpperCase(), name: b.name.toUpperCase() });
    } catch (e) {
      // Fail closed: decided as itself, a write through a QTEMP alias to a live table would pass.
      const reason = `could not resolve alias/view bases of ${o.lib}.${o.name}: ${(e as Error).message}`;
      this.notes.push(reason);
      const d: Operation = { ...op, class: "danger", reason };
      delete d.env;
      delete d.code;
      return [d];
    }
    const seen = new Set([key(o)]);
    const out: Operation[] = [];
    for (const b of found) {
      if (seen.has(key(b))) continue;
      seen.add(key(b));
      const base: Operation = { ...op, object: { ...b }, via: [...(op.via ?? []), `alias or view ${o.lib}.${o.name}`] };
      delete base.reason;
      delete base.env;
      if (!b.lib) { base.class = "unqualified"; base.reason = `name the library: the alias ${o.lib}.${o.name} refers to an unqualified ${b.name}`; }
      const raw = key(b);
      const resolved = await this.names(base);
      out.push(resolved, ...(await this.bases(resolved, raw, depth + 1)));
    }
    return out;
  }
}

async function resolve(statements: ClassifiedStatement[], ctx: ClassifyContext, run: Run, notes: string[]): Promise<void> {
  const r = new Resolver(ctx, run.state.local, notes);
  for (const s of statements) {
    const out: Operation[] = [];
    for (const op of s.operations) {
      const raw = op.object ? key(op.object) : "";
      const named = await r.names(op);
      out.push(named, ...(await r.bases(named, raw)));
    }
    s.operations = out;
    if (out.some((o) => o.class === "liblist")) r.curlibChanged = true;
  }
}

async function classifyStatements(statements: SplitStatement[], ctx: ClassifyContext): Promise<Classification> {
  const state: ScriptState = { local: new Map() };
  const r = newRun(ctx, state, []);
  const out: ClassifiedStatement[] = [];
  for (const s of statements) {
    const { operations, createdView } = statementOps(s, r);
    // A view created earlier in the script: writes through it reach the tables it reads.
    if (createdView && createdView.length === 2) {
      const reads = operations.filter((o) => o.class === "read" && o.object).map((o) => ({ ...o.object! }));
      state.local.set(`${createdView[0] === "SESSION" ? "QTEMP" : createdView[0]}.${createdView[1]}`, reads);
    }
    const c: ClassifiedStatement = { kind: s.kind, text: s.text, display: s.display, operations };
    if (s.error) c.error = s.error;
    out.push(c);
  }
  const notes: string[] = [];
  await resolve(out, ctx, r, notes);
  return { statements: out, operations: out.flatMap((s) => s.operations), notes };
}

// A script: SQL statements separated by `;`, and `CL:` lines.
export function classify(script: string, ctx: ClassifyContext): Promise<Classification> {
  return classifyStatements(splitScript(script), ctx);
}

// One CL command, as typed on a command line or built by compile_member (no `CL:` prefix).
export function classifyCl(command: string, ctx: ClassifyContext): Promise<Classification> {
  const text = command.replace(/\+[ \t]*\r?\n[ \t]*/g, "").trim();
  const shown = stripClComments(text);
  const s: SplitStatement = { kind: "cl", text, display: shown.text };
  if (shown.error) s.error = shown.error;
  return classifyStatements([s], ctx);
}
