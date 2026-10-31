// Offline decisions (design D9): a script decided for a stated identity and stated lookup answers,
// with no connection. `policy test` runs a file of such cases; `policy replay` re-decides run-log
// lines the same way.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { classify } from "./classify.js";
import { issueLines, parseYaml } from "./commands.js";
import { decide, detectPartition, worst, type Decision, type Identity } from "./decide.js";
import type { Policy, Verdict } from "./policy.js";
import { statedLookups, statementRule, type Answers, type RunLogLine } from "./runlog.js";
import type { Classification, Lookups } from "./types.js";

// Classify a script with the policy's command table and RDB map, and decide each statement.
export async function decideStatements(script: string, identity: Identity, policy: Policy, lookups: Lookups): Promise<{ classification: Classification; decisions: Decision[] }> {
  const classification = await classify(script, { lookups, commands: policy.commands, rdbs: policy.rdbs });
  return { classification, decisions: classification.statements.map((s) => decide(s.operations, identity, policy)) };
}

// --- policy test files ---

const verdict = z.enum(["allow", "confirm", "deny"]);
const caseSchema = z
  .object({
    name: z.string().min(1),
    as: z
      .object({
        user: z.string().min(1),
        groups: z.array(z.string()).optional(),
        authlists: z.array(z.string()).optional(),
        partition: z.string().optional(),
        curlib: z.string().optional(),
      })
      .strict(),
    script: z.string().min(1),
    lookups: z
      .object({
        schemas: z.record(z.string()).optional(),
        bases: z.record(z.array(z.string().regex(/^[^.]+\.[^.]+$/, "LIB.NAME"))).optional(),
      })
      .strict()
      .optional(),
    // One decision for the whole script (its most restrictive), or one per statement.
    expect: z.union([verdict, z.array(verdict).min(1)]),
  })
  .strict();
export type PolicyTest = z.infer<typeof caseSchema>;

export function parsePolicyTests(text: string, file: string): PolicyTest[] {
  const raw = parseYaml(text, file);
  if (Array.isArray(raw))
    raw.forEach((c, i) => {
      if (c && typeof c === "object" && "verb" in c) throw new Error(`${file}: ${i}: verb cases need verbs (project-verbs); state the script`);
    });
  const r = z.array(caseSchema).min(1).safeParse(raw);
  if (!r.success) throw new Error(issueLines(file, r.error));
  return r.data;
}

export function loadPolicyTests(path: string): PolicyTest[] {
  if (!existsSync(path)) throw new Error(`test file not found: ${path}`);
  return parsePolicyTests(readFileSync(path, "utf8"), path);
}

export interface TestResult {
  name: string;
  ok: boolean;
  expected: Verdict | Verdict[];
  statements: { text: string; decision: Decision }[];
}

// Each case decided offline; `expect` is compared with the policy's decision, not the effective
// one, so a deny on an observe-mode partition is still tested.
export async function runPolicyTests(policy: Policy, cases: PolicyTest[]): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const t of cases) {
    const p = t.as.partition;
    // A partition the policy does not define would decide every case on the wrong box.
    if (p !== undefined && policy.partitions.length) {
      const { conflict } = detectPartition(policy, { declared: p });
      if (conflict) throw new Error(`case "${t.name}": ${conflict}`);
    }
    const identity: Identity = { user: t.as.user, groups: t.as.groups ?? [], authlists: t.as.authlists ?? [] };
    if (p !== undefined) identity.partition = p;
    // The classifier asks in upper case; a test file may write the names in any case.
    const upper = <T>(r: Record<string, T> | undefined) => r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toUpperCase(), v]));
    const answers: Answers = {};
    if (t.lookups?.schemas) answers.schemas = upper(t.lookups.schemas);
    if (t.lookups?.bases) answers.bases = upper(t.lookups.bases);
    if (t.as.curlib) answers.curlib = t.as.curlib;
    const { classification, decisions } = await decideStatements(t.script, identity, policy, statedLookups(answers));
    const got = decisions.map((d) => d.decision);
    const ok = typeof t.expect === "string" ? worst(got) === t.expect : got.length === t.expect.length && got.every((g, i) => g === (t.expect as Verdict[])[i]);
    out.push({ name: t.name, ok, expected: t.expect, statements: classification.statements.map((s, i) => ({ text: s.display, decision: decisions[i] })) });
  }
  return out;
}

// A failed case for people: what was expected, then each statement's decision, operations and rule.
export function describeFailure(r: TestResult): string {
  const got = r.statements.map((s) => s.decision.decision);
  const lines = [`FAIL ${r.name}: expected ${[r.expected].flat().join(", ")}, got ${typeof r.expected === "string" ? worst(got) : got.join(", ")}`];
  r.statements.forEach((s, i) => {
    const rule = statementRule(s.decision);
    lines.push(`  statement ${i + 1}: ${s.text}`, `    ${s.decision.decision}${rule ? ` by rule ${rule}` : ""} (roles ${s.decision.roles.join(", ") || "none"})`);
    for (const o of s.decision.operations) lines.push(`    - ${o.message}`);
    if (!s.decision.operations.length) lines.push(`    - ${s.decision.reason}`);
  });
  return lines.join("\n");
}

// --- replay ---

// Recorded lookup answers (runlog.ts Answers), checked before replay trusts them.
const answersSchema = z
  .object({
    schemas: z.record(z.string().nullable()).optional(),
    bases: z.record(z.array(z.string())).optional(),
    curlib: z.string().nullable().optional(),
  })
  .strict();

export interface ReplayOutcome {
  decision: Verdict;
  effective: Verdict;
  rule?: number;
}

export interface ReplayChange {
  line: RunLogLine;
  before: ReplayOutcome;
  after: ReplayOutcome;
}

// Re-decide logged statements under a candidate policy, with each line's identity and lookup
// answers. A call's statements are classified together and in order, so what the script itself
// set up (a QTEMP alias, a CONNECT) is seen again. A statement changes when its decision or its
// effective decision does: an observed deny that an enforcing candidate would stop is a change.
export async function replayRunLog(candidate: Policy, lines: RunLogLine[]): Promise<{ statements: number; changes: ReplayChange[]; skipped: string[] }> {
  const calls = new Map<string, RunLogLine[]>();
  for (const l of lines) {
    const group = calls.get(l.call);
    if (group) group.push(l);
    else calls.set(l.call, [l]);
  }
  const changes: ReplayChange[] = [];
  const skipped: string[] = [];
  let statements = 0;
  for (const [id, group] of calls) {
    group.sort((a, b) => a.index - b.index);
    const at = `call ${id} at ${group[0].time}`;
    if (group.some((l) => l.scrubbed)) {
      skipped.push(`${at}: the profile password was taken out of it, so its text may not be what ran`);
      continue;
    }
    let decisions: Decision[];
    try {
      // Every statement of the call, in order; its lookup answers are on its first line.
      if (group.some((l, i) => l.index !== i)) throw new Error(`its statements in the log are ${group.map((l) => l.index).join(", ")}, not 0 to ${group.length - 1}: a line is missing`);
      // The candidate decides the partition from the names the box gave; without them the logged
      // partition must be one the candidate defines.
      const logged = group[0].identity;
      const identity: Identity = { user: logged.user };
      if (logged.groups) identity.groups = logged.groups;
      if (logged.authlists) identity.authlists = logged.authlists;
      const found = group[0].names ? detectPartition(candidate, group[0].names) : { partition: logged.partition, conflict: logged.conflict };
      if (!group[0].names && found.partition !== undefined && candidate.partitions.length && detectPartition(candidate, { declared: found.partition }).conflict)
        throw new Error(`logged partition ${found.partition} is not a partition of the candidate, and the line has no System or RDB names`);
      if (found.partition !== undefined) identity.partition = found.partition;
      if (found.conflict !== undefined) identity.conflict = found.conflict;
      const parsed = answersSchema.safeParse(group[0].lookups ?? {});
      if (!parsed.success) throw new Error(issueLines("lookups", parsed.error).replaceAll("\n", "; "));
      // A question the live run never asked has no recorded answer: replay cannot know it.
      const answers = parsed.data;
      const stated = statedLookups(answers);
      const missed: string[] = [];
      const lookups: Lookups = {
        systemSchema: (schema) => (Object.hasOwn(answers.schemas ?? {}, schema) || missed.push(`the system name of schema ${schema}`), stated.systemSchema(schema)),
        baseTables: (o) => (Object.hasOwn(answers.bases ?? {}, `${o.lib}.${o.name}`) || missed.push(`the base tables of ${o.lib}.${o.name}`), stated.baseTables(o)),
        currentLibrary: () => ("curlib" in answers || missed.push("the current library"), stated.currentLibrary()),
      };
      const script = group.map((l) => (l.kind === "cl" ? `CL: ${l.text}\n` : `${l.text}\n;\n`)).join("");
      ({ decisions } = await decideStatements(script, identity, candidate, lookups));
      if (missed.length) throw new Error(`the candidate looks up ${[...new Set(missed)].join(", ")}, which the logged run never did`);
    } catch (e) {
      skipped.push(`${at}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (decisions.length !== group.length) {
      skipped.push(`${at}: its logged text splits into ${decisions.length} statements, not ${group.length}`);
      continue;
    }
    statements += group.length;
    group.forEach((line, i) => {
      const d = decisions[i];
      const after: ReplayOutcome = { decision: d.decision, effective: d.effective };
      const rule = statementRule(d);
      if (rule) after.rule = rule;
      const before: ReplayOutcome = { decision: line.decision, effective: line.effective };
      if (line.rule) before.rule = line.rule;
      if (before.decision !== after.decision || before.effective !== after.effective) changes.push({ line, before, after });
    });
  }
  return { statements, changes, skipped };
}
