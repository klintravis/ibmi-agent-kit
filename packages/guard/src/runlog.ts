// The run log (design D8): one JSON line per decided statement in <dir>/YYYY-MM-DD.jsonl (UTC
// date). Each line carries the identity and the lookup answers it was decided with, so
// `policy replay` can decide it again without a connection. A local record the user can edit,
// not an audit trail.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Decision, Identity, RoleSource } from "./decide.js";
import { spansOf } from "./lexer.js";
import type { Mode, Policy, Verdict } from "./policy.js";
import type { Lookups, ObjectRef, OpClass, Operation, Statement } from "./types.js";

// --- redaction ---

// One whole SQL value: a string (with an N, G, X, UX or GX prefix), a delimited name, or one bare
// token (a host variable, a number, a name).
const WHOLE_VALUE = /^(?:(?:N|G|X|UX|GX)?'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s;,()'"]+)$/i;
// Where a password clause's value starts; it runs to the next top-level , or ;, an unmatched ),
// or WITH or WHERE.
const SQL_SECRETS = [/\bIDENTIFIED\s+BY\b/gi, /\bENCRYPTION\s+PASSWORD\b\s*=?/gi, /\bPASSWORD\s*=/gi, /\bCONNECT(?:\s+TO\s+\S+)?\s+USER\s+\S+\s+USING\b/gi];
// ENCRYPT_RC2(data, password, hint), DECRYPT_CHAR(data, password, ...): the second argument.
const SQL_CRYPT = /\b(?:ENCRYPT|DECRYPT)_\w+\s*\(/gi;
const CL_SECRET = /\b(?:PASSWORD|PWD|PWRDVPWD|NEWPWD|CURPWD|RMTPWD)\s*\(/gi;
// CHGUSRPRF JDOE SECRET1: the password is the second positional parameter.
const CL_POSITIONAL = /(\b(?:CHGUSRPRF|CRTUSRPRF)\s+(?![\w#$@]+\s*\()(?:'(?:[^']|'')*'|[^\s()']+)\s+)(?![\w#$@]+\s*\()('(?:[^']|'')*'|[^\s()']+)/gi;

const hide = (v: string) => (v.startsWith("'") ? "'***'" : v.startsWith('"') ? '"***"' : "***");

type Spans = ReturnType<typeof spansOf>;
// The text with every comment turned into as many spaces, offsets kept: patterns run on it, so a
// comment between keywords (CHGUSRPRF JDOE /* x */ SECRET1) hides nothing.
const blank = (s: string, sp: Spans) => sp.comments.reduce((c, [a, b]) => c.slice(0, a) + " ".repeat(b - a) + c.slice(b), s);
// Inside a literal or a delimited name: text, never a keyword.
const quoted = (sp: Spans, at: number) => sp.strings.some((s) => at >= s.start && at < s.end) || sp.names.some(([a, b]) => at >= a && at < b);

// The top-level commas of a parenthesised list starting just after its "(", and its ")" (the end
// of the text when unclosed). Literals, delimited names and comments are stepped over whole.
function args(s: string, start: number, sp: Spans): { commas: number[]; close: number } {
  const commas: number[] = [];
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const skip = sp.skips.get(i);
    if (skip !== undefined) i = skip - 1;
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return { commas, close: i };
    else if (s[i] === "," && depth === 1) commas.push(i);
  }
  return { commas, close: s.length };
}

// The end of a password clause's value starting at `start`.
function clauseEnd(s: string, start: number, sp: Spans): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const skip = sp.skips.get(i);
    if (skip !== undefined) i = skip - 1;
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth < 0) return i;
    else if (depth === 0 && (s[i] === "," || s[i] === ";")) return i;
    else if (depth === 0 && /^(?:WITH|WHERE)\b/i.test(s.slice(i, i + 6)) && !/[\p{L}\p{N}_#$@]/u.test(s[i - 1] ?? "")) return i;
  }
  return s.length;
}

// Password-bearing CL parameters and SQL clauses become ***, quotes kept so the text still splits
// and classifies the same. Every comment's content becomes *** first (comments never classify),
// then code is redacted, then each '...' literal again from its unescaped content (a QCMDEXC
// command, RUNSQL SQL, EXECUTE IMMEDIATE text), with its quotes doubled back.
export function redact(text: string): string {
  let s = text;
  let sp = spansOf(s);
  for (const [a, b] of [...sp.comments].sort((x, y) => y[0] - x[0]))
    s = s.slice(0, a) + (s.startsWith("--", a) ? "-- ***" : "/* *** */") + s.slice(b);
  sp = spansOf(s);
  let code = blank(s, sp);
  let out = "";
  let last = 0;
  for (const m of code.matchAll(CL_SECRET)) {
    const start = m.index! + m[0].length;
    if (start <= last || quoted(sp, m.index!)) continue;
    out += s.slice(last, start) + "***";
    last = args(s, start, sp).close;
  }
  s = out + s.slice(last);
  sp = spansOf(s);
  code = blank(s, sp);
  const positional: [number, number][] = [];
  for (const m of code.matchAll(CL_POSITIONAL)) if (!quoted(sp, m.index!)) positional.push([m.index! + m[1].length, m[2].length]);
  for (const [at, n] of positional.reverse()) s = s.slice(0, at) + hide(s.slice(at, at + n)) + s.slice(at + n);

  // A password value (a clause's, or ENCRYPT_*/DECRYPT_*'s argument): one whole token is hidden;
  // in an expression every literal is, names kept so its reads and calls still count.
  sp = spansOf(s);
  code = blank(s, sp);
  const edits = new Map<number, number>();
  const value = (from: number, to: number) => {
    const raw = s.slice(from, to);
    const v = raw.trim();
    // A literal's N, G, X, UX or GX prefix stays outside the edit, as when it is found as a literal.
    const lead = WHOLE_VALUE.test(v) ? (/^[A-Za-z]{1,2}(?=')/.exec(v)?.[0].length ?? 0) : -1;
    if (lead >= 0) edits.set(from + raw.indexOf(v) + lead, v.length - lead);
    else for (const lit of sp.strings) if (lit.start >= from && lit.end <= to) edits.set(lit.start, lit.end - lit.start);
  };
  for (const re of SQL_SECRETS)
    for (const m of code.matchAll(re)) {
      if (quoted(sp, m.index!)) continue;
      const start = m.index! + m[0].length;
      value(start, clauseEnd(s, start, sp));
    }
  for (const m of s.matchAll(SQL_CRYPT)) {
    if (quoted(sp, m.index!)) continue;
    const { commas, close } = args(s, m.index! + m[0].length, sp);
    if (commas.length) value(commas[0] + 1, commas[1] ?? close);
  }
  for (const [at, n] of [...edits].sort((a, b) => b[0] - a[0])) s = s.slice(0, at) + hide(s.slice(at, at + n)) + s.slice(at + n);

  sp = spansOf(s);
  for (const lit of [...sp.strings].reverse()) {
    const inner = redact(lit.value);
    if (inner !== lit.value) s = s.slice(0, lit.start) + "'" + inner.replaceAll("'", "''") + "'" + s.slice(lit.end);
  }
  return s;
}

// --- lookup answers ---

// What the box answered while a script was classified: a schema's system name (null for none or
// a failed lookup), an alias or view's base tables as "LIB.NAME" ([] for a table, null for a
// failed lookup, which fails closed again on replay) and the current library (null when unknown).
// Policy test files state the same shape.
export interface Answers {
  schemas?: Record<string, string | null>;
  bases?: Record<string, string[] | null>;
  curlib?: string | null;
}

const own = <T>(r: Record<string, T> | undefined, k: string): T | undefined => (r && Object.hasOwn(r, k) ? r[k] : undefined);

// Lookups answered from stated answers; anything not stated is "none".
export function statedLookups(a: Answers = {}): Lookups {
  return {
    systemSchema: async (schema) => own(a.schemas, schema) ?? undefined,
    baseTables: async ({ lib, name }) => {
      const bases = own(a.bases, `${lib}.${name}`);
      if (bases === null) throw new Error("the lookup failed when this was decided live");
      return (bases ?? []).map((b) => {
        const dot = b.indexOf(".");
        return { lib: b.slice(0, dot), name: b.slice(dot + 1) };
      });
    },
    currentLibrary: async () => a.curlib ?? undefined,
  };
}

// Wraps the server's lookups and keeps every answer, failures included, for the run log.
export function recordLookups(inner: Lookups): { lookups: Lookups; answers: Answers } {
  const answers: Answers = {};
  const keep = async <T, R>(p: Promise<T>, put: (v: T | undefined) => R): Promise<T> => {
    try {
      const v = await p;
      put(v);
      return v;
    } catch (e) {
      put(undefined);
      throw e;
    }
  };
  return {
    answers,
    lookups: {
      systemSchema: (schema) => keep(inner.systemSchema(schema), (v) => ((answers.schemas ??= {})[schema] = v ?? null)),
      baseTables: (o) => keep(inner.baseTables(o), (v) => ((answers.bases ??= {})[`${o.lib}.${o.name}`] = v ? v.map((b) => `${b.lib}.${b.name}`) : null)),
      currentLibrary: () => keep(inner.currentLibrary(), (v) => (answers.curlib = v ?? null)),
    },
  };
}

// --- lines ---

export interface LoggedOperation {
  class: OpClass;
  object?: ObjectRef;
  command?: string;
  via?: string[];
  env?: string;
  partition?: string;
  decision: Verdict;
  enforced: boolean;
  reason: string;
  rule?: number;
  message: string;
}

export interface RunLogLine {
  time: string; // ISO, UTC
  call: string; // one tool call; its statements share it, in `index` order
  index: number;
  server: string;
  tool: string;
  identity: Identity; // user, groups, authorization lists, partition (and a conflict)
  roles: string[];
  roleSource: RoleSource;
  partition?: string;
  mode: Mode;
  policy: string; // Policy.hash
  kind: "sql" | "cl" | "tool";
  text: string; // redacted
  operations: LoggedOperation[];
  raw?: Operation[]; // kind tool: the operations as the tool built them, which replay decides again
  rule?: number; // the rule behind the statement's decision
  decision: Verdict;
  effective: Verdict;
  enforced: boolean;
  reason?: "no_operations" | "partition_conflict";
  confirmed?: boolean;
  outcome: string;
  lookups?: Answers; // on the call's first line (index 0) only, as are notes
  notes?: string[];
  names?: PartitionNames;
  scrubbed?: true; // the profile password was taken out of a string: replay skips the call
}

// The names the partition was detected from, so replay can detect it again under a candidate.
export interface PartitionNames {
  system?: string;
  rdb?: string;
  declared?: string;
}

// A tool call with no statement text (read_source_member, manage_library_list ...): a readable
// text and the operations the tool built, each with its own partition and env (design D8).
export interface ToolStatement {
  kind: "tool";
  text: string;
  display: string;
  operations: Operation[];
}

export interface CallRecord {
  server: string;
  tool: string;
  identity: Identity;
  names?: PartitionNames;
  lookups: Answers;
  notes?: string[];
  statements: { statement: Statement | ToolStatement; decision: Decision; confirmed?: boolean; outcome: string }[];
  // The profile password: removed from every string of every line, whatever the case.
  secret?: string;
  time?: Date;
}

// The rule behind a statement's decision: that of its first operation with that decision.
export function statementRule(d: Decision): number | undefined {
  return d.operations.find((o) => o.decision === d.decision)?.rule;
}

function scrub(value: unknown, clean: (s: string) => string): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, clean));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), scrub(v, clean)]));
  return value;
}

// The lines for one tool call, redacted.
export function runLogLines(call: CallRecord, policy: Policy): RunLogLine[] {
  const time = (call.time ?? new Date()).toISOString();
  const id = randomUUID();
  const partition = call.identity.partition ?? policy.unknownPartition;
  const mode = partition !== undefined && Object.hasOwn(policy.mode.partitions, partition) ? policy.mode.partitions[partition] : policy.mode.default;
  // As typed, and with ' doubled as it stands inside a literal.
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const secret = call.secret ? new RegExp([...new Set([call.secret.replaceAll("'", "''"), call.secret])].map(esc).join("|"), "gi") : undefined;
  let hit = false;
  const clean = (s: string) => {
    const r = redact(s);
    const t = secret ? r.replace(secret, "***") : r;
    if (t !== r) hit = true;
    return t;
  };
  return call.statements.map(({ statement, decision: d, confirmed, outcome }, index) => {
    const line: RunLogLine = {
      time,
      call: id,
      index,
      server: call.server,
      tool: call.tool,
      identity: call.identity,
      roles: d.roles,
      roleSource: d.roleSource,
      mode,
      policy: policy.hash,
      kind: statement.kind,
      text: statement.text,
      operations: d.operations.map((o) => {
        const op: LoggedOperation = { class: o.operation.class, decision: o.decision, enforced: o.enforced, reason: o.reason, message: o.message };
        if (o.operation.object) op.object = o.operation.object;
        if (o.operation.command) op.command = o.operation.command;
        if (o.operation.via) op.via = o.operation.via;
        if (o.env) op.env = o.env;
        if (o.partition) op.partition = o.partition;
        if (o.rule) op.rule = o.rule;
        return op;
      }),
      decision: d.decision,
      effective: d.effective,
      enforced: d.enforced,
      outcome,
    };
    if (statement.kind === "tool") line.raw = statement.operations;
    if (partition !== undefined) line.partition = partition;
    const rule = statementRule(d);
    if (rule) line.rule = rule;
    if (d.reason) line.reason = d.reason;
    if (confirmed !== undefined) line.confirmed = confirmed;
    // Once per call, on its first line; replay reads them from there.
    if (index === 0) line.lookups = call.lookups;
    if (index === 0 && call.notes?.length) line.notes = call.notes;
    if (call.names) line.names = call.names;
    // Fixed-vocabulary fields are restored so a short password cannot garble them; a line the
    // password was taken out of is marked, and replay skips it (its text may have changed).
    hit = false;
    const { time: t, call: c, kind, mode: m, policy: h, decision, effective, roles, roleSource } = line;
    const out: RunLogLine = { ...(scrub(line, clean) as RunLogLine), time: t, call: c, kind, mode: m, policy: h, decision, effective, roles, roleSource };
    if (hit) out.scrubbed = true;
    return out;
  });
}

// Appends synchronously. A folder it cannot write is reported once on stderr and never throws:
// logging never changes a decision.
export class RunLog {
  private warned = false;
  constructor(
    readonly dir: string,
    private readonly policy: Policy,
    private readonly warn: (message: string) => void = (m) => console.error(m),
  ) {}

  record(call: CallRecord): void {
    try {
      const lines = runLogLines(call, this.policy);
      if (!lines.length) return;
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, `${lines[0].time.slice(0, 10)}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    } catch (e) {
      if (this.warned) return;
      this.warned = true;
      this.warn(`[ibmi-agent-kit] run log: cannot write to ${this.dir} (${(e as Error).message}); continuing without it`);
    }
  }
}
