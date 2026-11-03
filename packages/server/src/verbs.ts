// Verbs on the server (project-verbs design D2, D3, D5): verb_list, verb_run and policy_check's
// verb input. Every statement of a call, every verb of a suite with its nested verbs and cleanup,
// is planned and decided by the guard as one script before the first is sent, and one
// confirmation covers every `confirm`. The decision context, profile guards, confirmation and run
// log are run_script's (guarded.ts verbContext).
import { homedir } from "node:os";
import { delimiter, isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { message } from "./profile-write.js";
import type { Msg } from "@ibmi-agent-kit/core";
import {
  decidePlans,
  decideVerb,
  isPlannedVerb,
  loadVerbs,
  planVerb,
  recordLookups,
  resolveVerb,
  statementRule,
  type Answers,
  type CallRecord,
  type ClassifiedStatement,
  type DecidedStatement,
  type Decision,
  type Identity,
  type Lookups,
  type Planned,
  type PlannedVerb,
  type Policy,
  type VerbSet,
  type Verdict,
} from "@ibmi-agent-kit/guard";

// What runs the statements, on the job the call was decided against: any other job refuses
// before sending, and `stale` says the job is gone.
export interface Executor {
  query(sql: string, params: unknown[], maxRows: number): Promise<{ rows: Record<string, unknown>[] }>;
  execute(sql: string, params: unknown[]): Promise<{ rowsAffected: number; messages: Msg[] }>;
  cl(command: string): Promise<{ ok: boolean; messages: Msg[] }>;
  stale?(): boolean;
}

export interface ConfirmItem {
  label: string;
  decision: Decision;
  display: string;
}

// One server's decision context and executor, as of one job.
export interface VerbContext {
  policy: Policy;
  identity: Identity; // the signed-on user, partition resolved
  lookups: Lookups;
  exec: Executor;
  refusal?(s: ClassifiedStatement): string | undefined; // the profile's own guards
  confirm(needs: ConfirmItem[]): Promise<string | undefined>; // why not, or undefined for a yes
  recheck?(answers: Answers): Promise<string | undefined>; // after a yes: a looked-up current library that changed
  log?(call: Pick<CallRecord, "tool" | "lookups" | "notes" | "statements">): void; // the run log
}

export interface StatementResult {
  verb: string;
  where: string;
  kind: "sql" | "cl";
  text: string; // comments stripped
  decision: Verdict;
  effective: Verdict;
  rule?: number;
  outcome: string;
}

export interface VerbResult {
  verb: string;
  file?: string;
  status: "passed" | "failed" | "skipped";
  error?: string;
  notes: string[];
  statements: StatementResult[];
}

export interface RunReport {
  passed: number;
  failed: number;
  skipped: number;
  results: VerbResult[];
}

const at = (p: Planned) => `${p.verb} ${p.where}`;
const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : v === undefined ? "nothing" : String(v));
// How run_script and verb_run tell a query from a change: queries take the time limit.
export const QUERY = /^\s*(\(|SELECT\b|VALUES\b|WITH\b)/i;
const RESET_NOTE = "the connection was reset: nothing more was sent, cleanup included, on the old job or a new one; QTEMP and the library list of the old job are gone, so clean up by hand";

// Why each statement may not run: the verb's read-only rule, the profile's guards, the policy.
function refusalsOf(ctx: VerbContext, ds: DecidedStatement[]): string[] {
  return [
    ...ds.flatMap((d) => (d.refusal ? [d.refusal] : [])),
    ...ds.flatMap((d) => {
      const r = ctx.refusal?.(d.statement);
      return r ? [`${at(d.planned)}: ${r}`] : [];
    }),
    ...ds
      .filter((d) => d.decision.effective === "deny")
      .map((d) => `${at(d.planned)} is denied: ${d.decision.operations.filter((o) => o.decision === "deny" && o.enforced).map((o) => o.message).join("; ") || d.decision.reason}`),
  ];
}

interface Prepared {
  verb: string;
  file?: string;
  plan?: PlannedVerb;
  decided: DecidedStatement[];
  error?: string;
  skip?: string;
}

// --- running ---

interface RunState {
  exec: Executor;
  out: Map<Planned, string>;
  reset: boolean; // once set, nothing more is sent in this call
  undone: Planned[]; // eligible cleanup that a reset kept from running
}

// An expectation that does not hold, in words; undefined when it holds.
async function expectation(exec: Executor, s: Planned): Promise<string | undefined> {
  const c = s.check ?? {};
  const { rows } = await exec.query(s.text, s.params, c.rows !== undefined ? c.rows + 1 : 1);
  if (c.empty) return rows.length ? "expected no rows, found at least one" : undefined;
  if (c.rows !== undefined) return rows.length === c.rows ? undefined : `expected ${c.rows} rows, found ${rows.length > c.rows ? `more than ${c.rows}` : rows.length}`;
  if (!rows.length) return `expected ${show(JSON.stringify(c.equals))}, found no row`;
  const row = rows[0];
  const misses: string[] = [];
  for (const [col, want] of Object.entries(c.equals ?? {})) {
    const key = Object.keys(row).find((k) => k.toUpperCase() === col.toUpperCase());
    if (key === undefined) misses.push(`${col}: no such column`);
    else if (!same(row[key], want)) misses.push(`${col}: expected ${show(want)}, found ${show(row[key])}`);
  }
  return misses.length ? misses.join("; ") : undefined;
}

// CHAR columns come back padded with blanks, and DECIMAL columns may come back as strings.
function same(got: unknown, want: string | number | boolean | null): boolean {
  if (want === null || got === null || got === undefined) return want === null && (got === null || got === undefined);
  if (typeof want === "number") return typeof got === "number" ? got === want : typeof got === "string" && got.trim() !== "" && Number(got) === want;
  if (typeof want === "boolean") return got === want;
  return String(got).trimEnd() === want;
}

// Send one statement and record its outcome; returns why it failed, or undefined. After a reset
// nothing is sent. A reset shows as a stale job: right away after a time limit, or on the next
// send after a lost connection, which the job generation check refuses before sending.
async function one(s: Planned, run: RunState): Promise<string | undefined> {
  const exec = run.exec;
  if (run.reset || exec.stale?.()) {
    run.reset = true;
    run.out.set(s, "not sent: connection reset");
    return "connection reset";
  }
  try {
    if (s.role === "requires_absent") {
      const { rows } = await exec.query(s.text, s.params, 1);
      run.out.set(s, rows.length ? "found a row" : "no row");
      return rows.length ? "found a row, so its test data is already there; this setup step and its cleanup do not run" : undefined;
    }
    if (s.role === "expect") {
      const miss = await expectation(exec, s);
      run.out.set(s, miss ? `does not hold: ${miss}` : "holds");
      return miss;
    }
    if (s.kind === "cl") {
      const r = await exec.cl(s.text);
      const msgs = r.messages.map((m) => (m.id ? `[${m.id}] ${m.text}` : m.text)).join(" ");
      if (!r.ok) throw new Error(msgs || "the command failed");
      run.out.set(s, `ok${msgs ? `: ${msgs}` : ""}`);
      return undefined;
    }
    if (QUERY.test(s.text)) {
      const { rows } = await exec.query(s.text, s.params, 100);
      run.out.set(s, `ok, ${rows.length} row(s)`);
      return undefined;
    }
    const r = await exec.execute(s.text, s.params);
    run.out.set(s, `ok, ${r.rowsAffected} rows affected${r.messages.length ? `: ${r.messages.map((m) => m.text).join("; ")}` : ""}`);
    return undefined;
  } catch (e) {
    if (exec.stale?.()) run.reset = true;
    run.out.set(s, `failed: ${message(e)}`);
    return message(e);
  }
}

// Setup (each requires_absent just before its own statement) → steps → cleanup for the setup ids
// that succeeded. Cleanup is always attempted, unless the connection was reset, and its failures
// are collected. Returns why the verb failed, or undefined.
async function runPlanned(p: PlannedVerb, run: RunState): Promise<string | undefined> {
  const done = new Set<string>();
  let error: string | undefined;
  for (const s of p.setup) {
    const why = (s.requiresAbsent && (await one(s.requiresAbsent, run))) || undefined;
    if (why) {
      error = `${at(s.requiresAbsent as Planned)}: ${why}`;
      break;
    }
    const failed = await one(s.run, run);
    if (failed) {
      error = `${at(s.run)}: ${failed}`;
      break;
    }
    if (s.id !== undefined) done.add(s.id);
  }
  if (!error)
    for (const s of p.steps) {
      const failed = isPlannedVerb(s) ? await runPlanned(s, run) : await one(s, run).then((w) => w && `${at(s)}: ${w}`);
      if (failed) {
        error = failed;
        break;
      }
    }
  const cleanupErrors: string[] = [];
  for (const c of p.cleanup) {
    if (!done.has(c.undoes as string)) {
      run.out.set(c, `not run: setup ${c.undoes} did not succeed`);
      continue;
    }
    const failed = await one(c, run);
    if (!failed) continue;
    if (run.reset) run.undone.push(c);
    else cleanupErrors.push(`${at(c)}: ${failed}`);
  }
  return [error, ...cleanupErrors].filter(Boolean).join("; ") || undefined;
}

export interface VerbCall {
  ref: string;
  args?: Record<string, unknown>;
  skip?: string; // why a suite skips it
}

// Plan every verb of the call, decide them all as one script in run order, ask one confirmation,
// then run each. A declined confirmation runs none; once a verb does not run in full, no later
// verb runs (they were decided as if it had); after a connection reset nothing more is sent.
export async function runVerbs(ctx: VerbContext, set: VerbSet, calls: VerbCall[]): Promise<RunReport> {
  const prepared = calls.map((c): Prepared => {
    if (c.skip !== undefined) return { verb: c.ref, decided: [], skip: c.skip };
    const p: Prepared = { verb: c.ref, decided: [] };
    try {
      const v = resolveVerb(set, c.ref);
      p.verb = v.address;
      p.file = v.file;
      p.plan = planVerb(set, c.ref, c.args);
    } catch (e) {
      p.error = `nothing was sent: ${message(e)}`;
    }
    return p;
  });
  const planned = prepared.filter((p) => p.plan && !p.error);
  const rec = recordLookups(ctx.lookups);
  const notes: string[] = [];
  try {
    const r = await decidePlans(planned.map((p) => p.plan as PlannedVerb), ctx.identity, ctx.policy, rec.lookups);
    notes.push(...r.notes);
    planned.forEach((p, i) => {
      p.decided = r.statements[i];
      const refusals = refusalsOf(ctx, p.decided);
      if (refusals.length) p.error = `nothing was sent: ${refusals.join("; ")}`;
    });
  } catch (e) {
    for (const p of planned) p.error = `nothing was sent: ${message(e)}`;
  }

  const ready = planned.filter((p) => !p.error);
  const asked = ready.flatMap((p) => p.decided).filter((d) => d.decision.effective === "confirm");
  let confirmed: boolean | undefined;
  if (asked.length) {
    let no = await ctx.confirm(asked.map((d) => ({ label: at(d.planned), decision: d.decision, display: d.statement.display })));
    confirmed = no === undefined;
    // One confirmation covers the call, so a current library that moved stops all of it.
    no ??= await ctx.recheck?.(rec.answers);
    if (no !== undefined) for (const p of ready) p.error = `nothing was sent: ${no}`;
  }

  const run: RunState = { exec: ctx.exec, out: new Map(), reset: false, undone: [] };
  const results: VerbResult[] = [];
  // Later verbs were decided as if every earlier one in the script ran in full; once one did not
  // (refused, requires_absent hit, failed, stopped early), those decisions no longer hold.
  let broken = false;
  for (const p of prepared) {
    if (p.skip !== undefined) {
      results.push({ verb: p.verb, status: "skipped", error: p.skip, notes: [], statements: [] });
      continue;
    }
    const verbNotes: string[] = [];
    let error = p.error;
    if (!error && run.reset) error = "not sent: the connection was reset during an earlier verb of this call";
    else if (!error && broken) error = "not sent: an earlier verb in this call did not run in full";
    else if (!error && p.plan) {
      run.undone = [];
      error = await runPlanned(p.plan, run);
      if (run.reset) {
        error = `${error ?? "the connection was lost"}; connection reset; nothing more was sent; cleanup not run: ${run.undone.map((c) => `${at(c)}: ${c.text}`).join("; ") || "none"}`;
        verbNotes.push(RESET_NOTE);
      }
    }
    const statements = p.decided.map((d): StatementResult => {
      const r: StatementResult = { verb: d.planned.verb, where: d.planned.where, kind: d.planned.kind, text: d.statement.display, decision: d.decision.decision, effective: d.decision.effective, outcome: run.out.get(d.planned) ?? "not run" };
      const rule = statementRule(d.decision);
      if (rule) r.rule = rule;
      return r;
    });
    const r: VerbResult = { verb: p.verb, status: error ? "failed" : "passed", notes: verbNotes, statements };
    if (p.file) r.file = p.file;
    if (error) r.error = error;
    if (error && planned.includes(p)) broken = true; // a verb that failed to plan was never in the script
    results.push(r);
  }

  // One run-log call, as decided: every verb's statements in run order. `confirmed` only on the
  // statements that were in the question.
  const inQuestion = new Set(asked);
  const logged = planned.filter((p) => p.decided.length);
  if (logged.length)
    ctx.log?.({
      tool: "verb_run",
      lookups: rec.answers,
      notes: [...logged.map((p) => `verb ${p.verb} from ${p.file}`), ...notes, ...(run.reset ? [RESET_NOTE] : [])],
      statements: logged.flatMap((p) => p.decided).map((d) => ({ statement: d.statement, decision: d.decision, ...(inQuestion.has(d) && confirmed !== undefined ? { confirmed } : {}), outcome: run.out.get(d.planned) ?? "not run" })),
    });
  const count = (s: VerbResult["status"]) => results.filter((r) => r.status === s).length;
  return { passed: count("passed"), failed: count("failed"), skipped: count("skipped"), results };
}

// A tag's verbs in address order, with defaults. A verb a closer layer overrides is skipped, as is
// one with a parameter that has no default.
export function suite(set: VerbSet, tag: string): VerbCall[] {
  return set.verbs
    .filter((v) => v.tags.includes(tag))
    .map((v): VerbCall => {
      if (v.overridden) return { ref: v.address, skip: `overridden: a closer layer's ${v.name} is what a bare name runs` };
      const need = Object.entries(v.params).filter(([, p]) => p.default === undefined).map(([k]) => k);
      return need.length ? { ref: v.address, skip: `skipped: ${need.join(", ")} has no default` } : { ref: v.address };
    });
}

// policy_check for a verb: every statement decided, with why it may not run (the verb's read-only
// rule or the profile's guards). Sends only lookups.
export async function checkVerb(ctx: VerbContext, set: VerbSet, ref: string, args?: Record<string, unknown>) {
  const plan = planVerb(set, ref, args);
  const r = await decideVerb(plan, ctx.identity, ctx.policy, ctx.lookups);
  return {
    verb: plan.verb.address,
    file: plan.verb.file,
    statements: r.statements.map((d) => ({ ...d, refused: d.refusal ?? ctx.refusal?.(d.statement) })),
  };
}

// The server's verbs, loaded once per server on its first verb call and never reloaded:
// IBMI_KIT_VERBS and IBMI_KIT_POLICY (the org layer sits beside it) are that server's profile
// settings. Like IBMI_KIT_POLICY, IBMI_KIT_VERBS folders must be absolute: a relative one would
// depend on the client's working folder.
export function verbLoader(profileEnv: (server: string) => Record<string, string>): (server: string) => VerbSet {
  const cache = new Map<string, VerbSet>();
  return (server) => {
    let set = cache.get(server);
    if (!set) {
      const env = profileEnv(server);
      const relative = (env.IBMI_KIT_VERBS ?? "").split(delimiter).map((d) => d.trim()).filter((d) => d && !isAbsolute(d));
      if (relative.length) throw new Error(`profile ${server}: IBMI_KIT_VERBS folders must be absolute paths, not ${relative.join(", ")}`);
      set = loadVerbs({ home: homedir(), cwd: process.cwd(), extra: env.IBMI_KIT_VERBS, policyFile: env.IBMI_KIT_POLICY?.trim() || undefined });
      cache.set(server, set);
    }
    return set;
  };
}

// --- tools ---

export const key = (server?: string) => server || "default";
export const serverArg = z.string().optional().describe("which IBM i to use, named by a .env.<name> file. Omit for the default .env server (see list_servers)");
const argsArg = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("parameter values by name; parameters left out take their defaults");
// policy_check's verb input (guarded.ts).
export const verbCheckInput = { verb: z.string().describe("a verb: NAME (closest layer), user:NAME, proj:NAME or org:NAME"), args: argsArg };

function reportText(r: RunReport): string {
  const lines = [`${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped`];
  for (const v of r.results) {
    lines.push(`${v.status.toUpperCase()} ${v.verb}${v.error ? `: ${v.error}` : ""}`);
    for (const s of v.statements) lines.push(`  ${s.verb} ${s.where} [${s.effective}${s.rule ? ` rule ${s.rule}` : ""}] ${s.text} -> ${s.outcome}`);
    for (const n of v.notes) lines.push(`  note: ${n}`);
  }
  return lines.join("\n");
}

export function registerVerbTools(mcp: McpServer, deps: { verbs(server: string): VerbSet; context(server: string): Promise<VerbContext> }): void {
  const reply = (text: string, structured: Record<string, unknown>, isError = false) => ({ content: [{ type: "text" as const, text }], structuredContent: structured, ...(isError ? { isError } : {}) });
  const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: message(e) }], isError: true });

  mcp.registerTool(
    "verb_list",
    {
      title: "List verbs",
      description:
        "List the verbs (named, parameterised IBM i procedures such as smoke tests) by layer: user (~/.ibmi-agent-kit/verbs), proj (.ibmi-kit/verbs and IBMI_KIT_VERBS), org (verbs/ beside the policy file). Shows tags, parameters, which verbs a closer layer overrides, and files refused at load. Check one with policy_check (verb, args).",
      inputSchema: { server: serverArg },
      annotations: { title: "List verbs", readOnlyHint: true },
    },
    async ({ server }) => {
      try {
        const set = deps.verbs(key(server));
        const verbs = set.verbs.map((v) => ({ address: v.address, layer: v.layer, file: v.file, description: v.description, tags: v.tags, params: v.params, overridden: v.overridden }));
        const text = [
          ...verbs.map((v) => `${v.address}${v.overridden ? " (overridden)" : ""}${v.tags.length ? ` [${v.tags.join(", ")}]` : ""}: ${v.description}${Object.keys(v.params).length ? ` (params: ${Object.entries(v.params).map(([k, p]) => `${k} ${p.type}${p.default !== undefined ? ` = ${p.default}` : ""}`).join(", ")})` : ""}`),
          ...set.errors.map((e) => `refused: ${e}`),
        ].join("\n");
        return reply(text || "no verbs", { verbs, refused: set.refused, errors: set.errors });
      } catch (e) {
        return fail(e);
      }
    },
  );

  mcp.registerTool(
    "verb_run",
    {
      title: "Run a verb",
      description:
        "Run one verb with arguments, or with `tag` every verb carrying that tag as a suite (each with its defaults, in address order). Every statement of the call, nested verbs and cleanup included, is decided by the execution policy as the signed-on user before anything runs, as one script: a denied verb runs nothing, one confirmation covers every statement that needs one, and once a suite verb does not run in full no later verb is sent. Cleanup undoes only setup steps that succeeded. After a connection reset nothing more is sent, cleanup included, and the result lists the cleanup left to do by hand.",
      inputSchema: { server: serverArg, verb: z.string().optional().describe("the verb to run: NAME (closest layer), user:NAME, proj:NAME or org:NAME"), args: argsArg, tag: z.string().optional().describe("run every verb with this tag instead of one verb") },
      annotations: { title: "Run a verb", readOnlyHint: false, destructiveHint: true },
    },
    async ({ server, verb, args, tag }) => {
      try {
        if ((verb === undefined) === (tag === undefined)) throw new Error("give exactly one of verb and tag");
        if (args && tag !== undefined) throw new Error("args go with verb; a tag suite runs each verb with its defaults");
        const set = deps.verbs(key(server));
        const calls = verb !== undefined ? [{ ref: verb, args }] : suite(set, tag as string);
        if (!calls.length) throw new Error(`no verb has the tag ${tag}`);
        const report = await runVerbs(await deps.context(key(server)), set, calls);
        return reply(reportText(report), { ...report }, report.failed > 0);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
