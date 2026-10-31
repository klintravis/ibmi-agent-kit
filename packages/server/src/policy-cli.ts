// `ibmi-agent-kit policy test|replay` (design D9): offline, no IBM i and no MCP. Returns the exit
// code: 0 done (replay lists changes and still exits 0), 1 a test case failed, 2 a usage or load error.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIRS } from "@ibmi-agent-kit/core";
import { describeFailure, loadPolicy, loadPolicyTests, replayRunLog, runPolicyTests, type ReplayOutcome, type RunLogLine } from "@ibmi-agent-kit/guard";

const USAGE = `usage:
  ibmi-agent-kit policy test <policy> <tests>
  ibmi-agent-kit policy replay <candidate> [--since <days>]`;

type Write = (text: string) => void;

// The run log's lines, oldest file first; lines that are not a run-log line are counted, not read.
function readRunLog(dir: string, sinceDays: number | undefined): { lines: RunLogLine[]; bad: number } {
  if (!existsSync(dir)) throw new Error(`no run log at ${dir}`);
  const from = sinceDays === undefined ? -Infinity : Date.now() - sinceDays * 86_400_000;
  const lines: RunLogLine[] = [];
  let bad = 0;
  // Day files are UTC dates: one dated before the cutoff's day holds nothing newer.
  const firstDay = sinceDays === undefined ? "" : new Date(from).toISOString().slice(0, 10);
  for (const f of readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= firstDay).sort())
    for (const text of readFileSync(join(dir, f), "utf8").split(/\r?\n/)) {
      if (!text.trim()) continue;
      let l: RunLogLine;
      try {
        l = JSON.parse(text);
      } catch {
        bad++;
        continue;
      }
      const verdict = (v: unknown) => v === "allow" || v === "confirm" || v === "deny";
      const ok =
        l &&
        typeof l.call === "string" &&
        typeof l.index === "number" &&
        typeof l.text === "string" &&
        (l.kind === "sql" || l.kind === "cl") &&
        typeof l.identity?.user === "string" &&
        typeof l.time === "string" &&
        !Number.isNaN(Date.parse(l.time)) &&
        verdict(l.decision) &&
        verdict(l.effective);
      if (!ok) bad++;
      else if (Date.parse(l.time) >= from) lines.push(l);
    }
  return { lines, bad };
}

const show = (o: ReplayOutcome) => `${o.decision}${o.effective !== o.decision ? ` (runs: ${o.effective})` : ""}${o.rule ? ` by rule ${o.rule}` : ""}`;

export async function policyCli(args: string[], out: Write = (t) => console.log(t), err: Write = (t) => console.error(t)): Promise<number> {
  try {
    const [cmd, ...rest] = args;
    if (cmd === "test" && rest.length === 2) {
      const policy = loadPolicy(rest[0]);
      for (const w of policy.warnings) err(`warning: ${w}`);
      const results = await runPolicyTests(policy, loadPolicyTests(rest[1]));
      const failed = results.filter((r) => !r.ok);
      for (const r of failed) out(describeFailure(r));
      out(failed.length ? `${failed.length} of ${results.length} cases failed` : `${results.length} cases passed`);
      return failed.length ? 1 : 0;
    }
    if (cmd === "replay" && (rest.length === 1 || (rest.length === 3 && rest[1] === "--since"))) {
      const since = rest[2] === undefined ? undefined : Number(rest[2]);
      if (since !== undefined && !(Number.isInteger(since) && since >= 0)) throw new Error(`--since takes a whole number of days, not ${rest[2]}`);
      const candidate = loadPolicy(rest[0]);
      for (const w of candidate.warnings) err(`warning: ${w}`);
      const dir = join(CONFIG_DIRS()[0], "runs");
      const { lines, bad } = readRunLog(dir, since);
      if (bad) err(`skipped ${bad} unreadable line(s) in ${dir}`);
      const r = await replayRunLog(candidate, lines);
      for (const s of r.skipped) err(`skipped ${s}`);
      for (const c of r.changes) {
        const l = c.line;
        out(`${l.time} ${l.identity.user} ${l.server} ${l.tool}${l.partition ? ` partition ${l.partition}` : ""}: ${l.text}`);
        out(`  ${show(c.before)} -> ${show(c.after)}`);
      }
      out(`${r.changes.length} of ${r.statements} statements change under ${rest[0]}${r.skipped.length ? `; ${r.skipped.length} calls skipped (see stderr)` : ""}`);
      return 0;
    }
    err(USAGE);
    return 2;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }
}
