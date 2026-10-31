// Verbs on the server (project-verbs design D2, D3, D5): verb_list, verb_run and policy_check's
// verb input. Every statement of a run, nested verbs and cleanup included, is planned and decided
// by the guard before the first is sent, and one confirmation covers every `confirm`. The decision
// context, profile guards, confirmation and run log are run_script's (guarded.ts verbContext).
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Msg } from "@ibmi-agent-kit/core";
import {
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

// What runs the statements, on the job the verb was decided against: any other job refuses
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
  log?(call: Pick<CallRecord, "tool" | "lookups" | "notes" | "statements">): void; // the run log
  renew?(): Promise<VerbContext>; // the same on the connection's current job, after a reset
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

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const at = (p: Planned) => `${p.verb} ${p.where}`;
const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : v === undefined ? "nothing" : String(v));
const RESET_NOTE = "the connection was reset during the verb: nothing more was sent on the old job, and cleanup was decided again and run on a new job that has lost QTEMP and the library list";

// Why each statement may not run: the verb's read-only rule, the profile's guards, the policy.
function refusalsOf(ctx: VerbContext, ds: DecidedStatement[], readOnly: string[]): string[] {
  return [
    ...readOnly,
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
  answers: Answers;
  notes: string[];
  error?: string;
  skip?: string;
}

async function prepare(ctx: VerbContext, set: VerbSet, ref: string, args?: Record<string, unknown>): Promise<Prepared> {
  const rec = recordLookups(ctx.lookups);
  const p: Prepared = { verb: ref, decided: [], answers: rec.answers, notes: [] };
  try {
    const v = resolveVerb(set, ref);
    p.verb = v.address;
    p.file = v.file;
    p.plan = planVerb(set, ref, args);
    const r = await decideVerb(p.plan, ctx.identity, ctx.policy, rec.lookups);
    p.decided = r.statements;
    p.notes = r.notes;
    const refusals = refusalsOf(ctx, r.statements, r.refusals);
    if (refusals.length) p.error = `nothing was sent: ${refusals.join("; ")}`;
  } catch (e) {
    p.error = `nothing was sent: ${errText(e)}`;
  }
  return p;
}

const needs = (ds: DecidedStatement[]): ConfirmItem[] =>
  ds.filter((d) => d.decision.effective === "confirm").map((d) => ({ label: at(d.planned), decision: d.decision, display: d.statement.display }));

// --- running ---

interface RunState {
  ctx: VerbContext; // replaced by a renewed one after a reset
  out: Map<Planned, string>;
  reset: boolean;
  confirmed: boolean; // whether the call's confirmation was given
  log: Prepared[]; // cleanup decided again after a reset, logged as calls of their own
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

// Send one statement and record its outcome; returns why it failed, or undefined.
async function one(s: Planned, run: RunState): Promise<string | undefined> {
  const exec = run.ctx.exec;
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
    const r = await exec.execute(s.text, s.params);
    run.out.set(s, `ok, ${r.rowsAffected} rows affected${r.messages.length ? `: ${r.messages.map((m) => m.text).join("; ")}` : ""}`);
    return undefined;
  } catch (e) {
    if (exec.stale?.()) run.reset = true;
    run.out.set(s, `failed: ${errText(e)}`);
    return errText(e);
  }
}

// After a reset: decide `cleanup` again on the connection's new job (its QTEMP, library list and
// current library are new) and switch the run to it. Returns why entries may not run there.
async function renew(p: PlannedVerb, cleanup: Planned[], run: RunState): Promise<Map<Planned, string>> {
  const blocked = new Map<Planned, string>();
  const prev = run.ctx;
  try {
    if (!prev.renew) throw new Error("this context cannot open a new one");
    run.ctx = await prev.renew();
    const rec = recordLookups(run.ctx.lookups);
    const r = await decideVerb({ ...p, setup: [], steps: [], cleanup }, run.ctx.identity, run.ctx.policy, rec.lookups);
    for (const d of r.statements) {
      const why = run.ctx.refusal?.(d.statement) ?? (d.decision.effective === "deny" ? "denied" : d.decision.effective === "confirm" && !run.confirmed ? "it now needs a confirmation that was not asked" : undefined);
      if (why) blocked.set(d.planned, `not sent: on the new connection ${why}`);
    }
    run.log.push({ verb: p.verb.address, file: p.verb.file, decided: r.statements, answers: rec.answers, notes: [`cleanup of ${p.verb.address} decided again after a connection reset`, ...r.notes] });
  } catch (e) {
    run.ctx = prev;
    for (const c of cleanup) blocked.set(c, `not sent: cleanup could not be decided on a new connection: ${errText(e)}`);
  }
  return blocked;
}

// Setup (each requires_absent just before its own statement) → steps → cleanup for the setup ids
// that succeeded. Cleanup is always attempted and its failures are collected. Returns why the
// verb failed, or undefined.
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
  const eligible = p.cleanup.filter((c) => done.has(c.undoes as string));
  for (const c of p.cleanup) if (!eligible.includes(c)) run.out.set(c, `not run: setup ${c.undoes} did not succeed`);
  const blocked = eligible.length && run.ctx.exec.stale?.() ? await renew(p, eligible, run) : new Map<Planned, string>();
  const cleanupErrors: string[] = [];
  for (const c of eligible) {
    const why = blocked.get(c);
    if (why) run.out.set(c, why);
    const failed = why ?? (await one(c, run));
    if (failed) cleanupErrors.push(`${at(c)}: ${failed}`);
  }
  return [error, ...cleanupErrors].filter(Boolean).join("; ") || undefined;
}

export interface VerbCall {
  ref: string;
  args?: Record<string, unknown>;
  skip?: string; // why a suite skips it
}

function logCall(ctx: VerbContext, p: Prepared, notes: string[], outcome: (d: DecidedStatement) => string, confirmed: boolean | undefined): void {
  if (!p.decided.length) return;
  ctx.log?.({
    tool: "verb_run",
    lookups: p.answers,
    notes: [`verb ${p.verb} from ${p.file}`, ...notes],
    statements: p.decided.map((d) => ({ statement: d.statement, decision: d.decision, ...(d.decision.effective === "confirm" && confirmed !== undefined ? { confirmed } : {}), outcome: outcome(d) })),
  });
}

// Decide every verb of the call first, ask one confirmation for all of them, then run each. A
// declined confirmation runs none; a refused verb fails and the others still run.
export async function runVerbs(ctx: VerbContext, set: VerbSet, calls: VerbCall[]): Promise<RunReport> {
  const prepared: Prepared[] = [];
  for (const c of calls) prepared.push(c.skip !== undefined ? { verb: c.ref, decided: [], answers: {}, notes: [], skip: c.skip } : await prepare(ctx, set, c.ref, c.args));
  const ready = prepared.filter((p) => !p.skip && !p.error);
  const asked = needs(ready.flatMap((p) => p.decided));
  let confirmed: boolean | undefined;
  if (asked.length) {
    const no = await ctx.confirm(asked);
    confirmed = no === undefined;
    if (no !== undefined) for (const p of ready) p.error = `nothing was sent: ${no}`;
  }
  const results: VerbResult[] = [];
  for (const p of prepared) {
    if (p.skip !== undefined) {
      results.push({ verb: p.verb, status: "skipped", error: p.skip, notes: [], statements: [] });
      continue;
    }
    const run: RunState = { ctx, out: new Map(), reset: false, confirmed: confirmed === true, log: [] };
    const error = p.error ?? (p.plan ? await runPlanned(p.plan, run) : undefined);
    const notes = [...p.notes, ...(run.reset ? [RESET_NOTE] : [])];
    const outcome = (d: DecidedStatement) => run.out.get(d.planned) ?? "not run";
    const statements = p.decided.map((d): StatementResult => {
      const r: StatementResult = { verb: d.planned.verb, where: d.planned.where, kind: d.planned.kind, text: d.statement.display, decision: d.decision.decision, effective: d.decision.effective, outcome: outcome(d) };
      const rule = statementRule(d.decision);
      if (rule) r.rule = rule;
      return r;
    });
    logCall(ctx, p, notes, outcome, confirmed);
    for (const again of run.log) logCall(run.ctx, again, again.notes, outcome, confirmed);
    const r: VerbResult = { verb: p.verb, status: error ? "failed" : "passed", notes, statements };
    if (p.file) r.file = p.file;
    if (error) r.error = error;
    results.push(r);
  }
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

// policy_check for a verb: every statement decided, with why it may not run. Sends only lookups.
export async function checkVerb(ctx: VerbContext, set: VerbSet, ref: string, args?: Record<string, unknown>) {
  const plan = planVerb(set, ref, args);
  const r = await decideVerb(plan, ctx.identity, ctx.policy, ctx.lookups);
  return {
    verb: plan.verb.address,
    file: plan.verb.file,
    refusals: r.refusals,
    statements: r.statements.map((d) => ({ ...d, refused: ctx.refusal?.(d.statement) })),
  };
}

// The server's verbs, loaded once per server on first use and never reloaded: IBMI_KIT_VERBS and
// IBMI_KIT_POLICY (the org layer sits beside it) are that server's profile settings.
export function verbLoader(profileEnv: (server: string) => Record<string, string>): (server: string) => VerbSet {
  const cache = new Map<string, VerbSet>();
  return (server) => {
    let set = cache.get(server);
    if (!set) {
      const env = profileEnv(server);
      set = loadVerbs({ home: homedir(), cwd: process.cwd(), extra: env.IBMI_KIT_VERBS, policyFile: env.IBMI_KIT_POLICY?.trim() || undefined });
      cache.set(server, set);
    }
    return set;
  };
}

// --- tools ---

const serverArg = z.string().optional().describe("which IBM i to use, named by a .env.<name> file. Omit for the default .env server (see list_servers)");
const argsArg = z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("parameter values by name; parameters left out take their defaults");
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
  const key = (server?: string) => server || "default";
  const reply = (text: string, structured: Record<string, unknown>, isError = false) => ({ content: [{ type: "text" as const, text }], structuredContent: structured, ...(isError ? { isError } : {}) });
  const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: errText(e) }], isError: true });

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
        "Run one verb with arguments, or with `tag` every verb carrying that tag as a suite (each with its defaults, continuing after failures). Every statement, nested verbs and cleanup included, is decided by the execution policy as the signed-on user before anything runs: any deny runs nothing, and one confirmation covers every statement that needs one. Cleanup undoes only setup steps that succeeded.",
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
