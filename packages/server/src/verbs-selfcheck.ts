// Verb runner and tools (project-verbs tasks 2.1, 2.2), end to end through the kit server and the
// execution guard's real context (guarded.ts), with a stub connection: no IBM i. Imported by
// selfcheck.ts, so `node --test dist/selfcheck.js` runs these too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { loadPolicy, loadVerbs, parsePolicy, type Policy, type VerbSet } from "@ibmi-agent-kit/guard";
import type { Conn } from "./guarded.js";
import { policyCli } from "./policy-cli.js";
import { createServer, shutdownAll, type ServerDeps } from "./server.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));
const D4 = loadPolicy(join(EXAMPLES, "three-partitions.yaml"));

// Enforcing everywhere: TLIB is a test library, LVLIB live (writes need confirmation), PAYLIB has
// no rule, so it is denied.
const POLICY_TEXT = `version: 1
mode: enforce
environments:
  - { name: test, match: ["T*"] }
  - { name: live, match: ["LV*"] }
  - { name: pay,  libraries: [PAYLIB] }
rules:
  - { env: live, classes: [read], decision: allow }
  - { env: live, decision: confirm }
  - { env: test, decision: allow }
`;
const POLICY = parsePolicy(POLICY_TEXT, "test-policy");

// Writes `files` (name → YAML) into a project verb folder and loads it.
function verbs(files: Record<string, string>): { set: VerbSet; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "kit-verbs-"));
  const dir = join(root, ".ibmi-kit", "verbs");
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  const set = loadVerbs({ cwd: root });
  assert.deepEqual(set.errors, []);
  return { set, dir };
}

type Row = Record<string, unknown>;
// A box: answers the guard's own identity and catalog queries, and records every verb statement
// that reaches it with the job generation it ran on. Like the backend, a send checks the job
// generation before sending. `resetOn` drops the job once, as the statement is about to be sent.
// `curlib`: the current library each time it is asked, the last repeating.
function box(o: { user?: string; group?: string; rdb?: string; rows?: (sql: string) => Row[]; fail?: string[]; resetOn?: string; readOnly?: boolean; blockedTables?: string[]; curlib?: string[] } = {}) {
  const sent: string[] = [];
  let curlibAsked = 0;
  const own = (sql: string): Row[] | undefined => {
    if (sql.startsWith("SELECT CURRENT SERVER")) return [{ RDB: o.rdb ?? "DEVRDB", USR: o.user ?? "JDOE" }];
    if (sql.includes("QSYS2.USER_INFO")) return [{ G: o.group ?? "GRPDEV", S: "" }];
    if (sql.includes("QSYS2.LIBRARY_LIST_INFO") && o.curlib) return [{ S: o.curlib[Math.min(curlibAsked++, o.curlib.length - 1)] }];
    if (/AUTHORIZATION_LIST_USER_INFO|QSYS2\.(SYSSCHEMAS|SYSTABLES|SYSVIEWDEP|LIBRARY_LIST_INFO)/.test(sql)) return [];
    return undefined;
  };
  const send = (text: string, generation?: number) => {
    if (o.resetOn && conn.generation === 0 && text.includes(o.resetOn)) conn.generation!++;
    if (generation !== undefined && generation !== conn.generation) throw new Error("the connection to the IBM i was reset after this was decided; not sent");
    sent.push(`${conn.generation}: ${text}`);
    if (o.fail?.some((f) => text.includes(f))) throw new Error(`SQL0803 duplicate key: ${text}`);
  };
  const conn: Conn = {
    generation: 0,
    profile: { user: o.user ?? "JDOE", password: "Secret1x", readOnly: o.readOnly ?? false, blockedTables: o.blockedTables ?? [], blockedCl: [] },
    async query(sql, _params, maxRows = 100, _reporter, generation) {
      const mine = own(sql);
      if (mine) return { rows: mine, columns: [], truncated: false };
      send(sql, generation);
      return { rows: (o.rows?.(sql) ?? []).slice(0, maxRows), columns: [], truncated: false };
    },
    async execute(sql, _params, _reporter, generation) {
      send(sql, generation);
      return { rowsAffected: 1, messages: [] };
    },
    async cl(command, _reporter, generation) {
      send(command, generation);
      return { ok: true, messages: [] };
    },
    async close() {
      conn.generation!++;
    },
  };
  return { conn, sent };
}

const YES = async (): Promise<ElicitResult> => ({ action: "accept", content: { confirm: true } });

// The kit server with the guard's real wiring around a stub box, and a client.
async function kit(o: { set?: VerbSet; policy?: Policy; box?: ReturnType<typeof box>; elicit?: (req: any) => Promise<ElicitResult>; deps?: ServerDeps } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kit-verb-runs-"));
  const b = o.box ?? box();
  const k = createServer({
    policy: o.policy ?? POLICY,
    conn: () => b.conn,
    profileEnv: () => ({}),
    runLogDir: dir,
    notice: () => {},
    confirmTimeoutMs: 5000,
    sqlTimeLimitMs: 5000,
    ...(o.set ? { verbs: () => o.set as VerbSet } : {}),
    ...o.deps,
  });
  const c = new Client({ name: "selfcheck", version: "0" }, o.elicit ? { capabilities: { elicitation: { form: {} } } } : undefined);
  if (o.elicit) c.setRequestHandler(ElicitRequestSchema, o.elicit);
  const [a, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([k.mcp.connect(s), c.connect(a)]);
  return {
    c,
    sent: b.sent,
    call: async (name: string, args: Record<string, unknown>) => {
      const r = await c.callTool({ name, arguments: args });
      return { error: r.isError === true, text: (r.content as { text: string }[])[0].text, s: r.structuredContent as any };
    },
    log: () => readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))),
    close: async () => {
      await c.close();
      await shutdownAll(k.engines);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// One verb_run call on a fresh kit; the kit is closed before returning.
async function run(o: Parameters<typeof kit>[0], args: Record<string, unknown>) {
  const k = await kit(o);
  try {
    const r = await k.call("verb_run", args);
    return { ...r, sent: k.sent, log: k.log() };
  } finally {
    await k.close();
  }
}

const verb = (name: string, body: string) => `name: ${name}\ndescription: ${name} test\n${body}`;
const SEEDED = verb(
  "SEEDED",
  `params:
  k: { type: integer, default: 7 }
setup:
  - id: seed
    requires_absent: "SELECT 1 FROM TLIB.T WHERE K = :k"
    sql: "INSERT INTO TLIB.T (K) VALUES (:k)"
steps:
  - sql: "UPDATE TLIB.T SET S = 'X' WHERE K = :k"
  - expect: { sql: "SELECT S FROM TLIB.T WHERE K = :k", equals: { S: V } }
  - sql: "UPDATE TLIB.T SET S = 'Y' WHERE K = :k"
cleanup:
  - { undoes: seed, sql: "DELETE FROM TLIB.T WHERE K = :k" }
`,
);
const holds = (sql: string) => (sql.startsWith("SELECT S") ? [{ S: "V" }] : []);

test("verb_run: a denied step sends nothing, and the result names it", async () => {
  const { set } = verbs({ "v.yaml": verb("V", "setup:\n  - { id: s, sql: INSERT INTO TLIB.T VALUES 1 }\nsteps:\n  - sql: DELETE FROM PAYLIB.T\ncleanup:\n  - { undoes: s, sql: DELETE FROM TLIB.T }\n") });
  const r = await run({ set }, { verb: "V" });
  assert.equal(r.error, true);
  assert.deepEqual(r.sent, []);
  assert.equal(r.s.failed, 1);
  assert.match(r.s.results[0].error, /^nothing was sent: proj:V steps\.0 is denied: no rule matches write PAYLIB\.T/);
  assert.deepEqual(r.s.results[0].statements.map((s: any) => s.outcome), ["not run", "not run", "not run"]);
});

test("verb_run: one confirmation covers every confirm; declined or unavailable sends nothing, accepted runs", async () => {
  const { set } = verbs({ "v.yaml": verb("V", "steps:\n  - sql: UPDATE LVLIB.T SET A = 1\n  - sql: SELECT * FROM LVLIB.T\n  - cl: CLRPFM FILE(LVLIB/T) /* all of it */\n") });
  const asked: string[] = [];
  const no = await run({ set, elicit: async (req) => (asked.push(req.params.message), { action: "decline" }) }, { verb: "V" });
  assert.deepEqual(no.sent, []);
  assert.equal(asked.length, 1, "one question for the whole call");
  assert.match(asked[0], /proj:V steps\.0:\n  - write LVLIB\.T \(environment live\)\nUPDATE LVLIB\.T SET A = 1\n\nproj:V steps\.2:\n.*\nCLRPFM FILE\(LVLIB\/T\)/);
  assert.match(no.s.results[0].error, /nothing was sent: the user chose decline/);
  const yes = await run({ set, elicit: YES }, { verb: "V" });
  assert.equal(yes.s.passed, 1);
  assert.deepEqual(yes.sent, ["0: UPDATE LVLIB.T SET A = 1", "0: SELECT * FROM LVLIB.T", "0: CLRPFM FILE(LVLIB/T)"]);
  assert.deepEqual(yes.log.filter((l) => l.confirmed !== undefined).map((l) => [l.index, l.confirmed]), [[0, true], [2, true]]);
  const none = await run({ set }, { verb: "V" });
  assert.deepEqual(none.sent, []);
  assert.match(none.text, /confirmation is unavailable in this client/);
});

test("verb_run: a current library that changes while confirming sends nothing; unchanged, the verb runs", async () => {
  const { set } = verbs({ "c.yaml": verb("CUR", "steps:\n  - cl: CLRPFM FILE(*CURLIB/T)\n") });
  const moved = await run({ set, elicit: YES, box: box({ curlib: ["LVLIB", "OTHER"] }) }, { verb: "CUR" });
  assert.deepEqual(moved.sent, []);
  assert.match(moved.s.results[0].error, /^nothing was sent: the current library changed from LVLIB to OTHER while confirming$/);
  assert.deepEqual(moved.log.map((l) => [l.confirmed, l.outcome]), [[true, "not run"]]);
  const same = await run({ set, elicit: YES, box: box({ curlib: ["LVLIB"] }) }, { verb: "CUR" });
  assert.deepEqual(same.sent, ["0: CLRPFM FILE(*CURLIB/T)"]);
});

test("verb_run: a requires_absent hit runs neither that setup nor its cleanup", async () => {
  const { set } = verbs({ "s.yaml": SEEDED });
  const r = await run({ set, box: box({ rows: (sql) => (sql.startsWith("SELECT 1 FROM TLIB.T") ? [{ X: 1 }] : []) }) }, { verb: "SEEDED" });
  assert.deepEqual(r.sent, ["0: SELECT 1 FROM TLIB.T WHERE K = ?"]);
  assert.match(r.s.results[0].error, /^proj:SEEDED setup\.0\.requires_absent: found a row, so its test data is already there/);
  assert.equal(r.s.results[0].statements.at(-1).outcome, "not run: setup seed did not succeed");
});

test("verb_run: an expectation mismatch reports expected and actual, stops the steps, and cleans up", async () => {
  const { set } = verbs({ "s.yaml": SEEDED });
  const r = await run({ set, box: box({ rows: (sql) => (sql.startsWith("SELECT S") ? [{ S: "E   " }] : []) }) }, { verb: "SEEDED" });
  assert.match(r.s.results[0].error, /^proj:SEEDED steps\.1\.expect: S: expected "V", found "E   "$/);
  assert.deepEqual(r.sent, [
    "0: SELECT 1 FROM TLIB.T WHERE K = ?",
    "0: INSERT INTO TLIB.T (K) VALUES (?)",
    "0: UPDATE TLIB.T SET S = 'X' WHERE K = ?",
    "0: SELECT S FROM TLIB.T WHERE K = ?",
    "0: DELETE FROM TLIB.T WHERE K = ?",
  ]);
  // blanks a CHAR column pads with do not fail an expectation
  assert.equal((await run({ set, box: box({ rows: (sql) => (sql.startsWith("SELECT S") ? [{ S: "V   " }] : []) }) }, { verb: "SEEDED" })).s.passed, 1);
});

test("verb_run: a failed setup skips its own cleanup; a failed step runs every eligible cleanup and reports each", async () => {
  const two = verb(
    "TWO",
    `setup:
  - { id: a, sql: INSERT INTO TLIB.A VALUES 1 }
  - { id: b, sql: INSERT INTO TLIB.B VALUES 1 }
steps:
  - sql: UPDATE TLIB.C SET X = 1
cleanup:
  - { undoes: a, sql: DELETE FROM TLIB.A }
  - { undoes: b, sql: DELETE FROM TLIB.B }
`,
  );
  const { set } = verbs({ "t.yaml": two });
  const r1 = await run({ set, box: box({ fail: ["INSERT INTO TLIB.B"] }) }, { verb: "TWO" });
  assert.deepEqual(r1.sent, ["0: INSERT INTO TLIB.A VALUES 1", "0: INSERT INTO TLIB.B VALUES 1", "0: DELETE FROM TLIB.A"]);
  assert.deepEqual(r1.s.results[0].statements.slice(3).map((s: any) => s.outcome), ["ok, 1 rows affected", "not run: setup b did not succeed"]);

  const r2 = await run({ set, box: box({ fail: ["UPDATE TLIB.C", "DELETE FROM TLIB.A"] }) }, { verb: "TWO" });
  assert.deepEqual(r2.sent.slice(3), ["0: DELETE FROM TLIB.A", "0: DELETE FROM TLIB.B"], "a failed cleanup does not stop the next");
  assert.match(r2.s.results[0].error, /^proj:TWO steps\.0: SQL0803 .*; proj:TWO cleanup\.0: SQL0803 /);
  assert.deepEqual(r2.s.results[0].statements.slice(3).map((s: any) => s.outcome.slice(0, 6)), ["failed", "ok, 1 "]);
});

test("verb_run: a reset refuses the next send on the old job; cleanup is decided again and runs on the new job", async () => {
  const { set } = verbs({ "s.yaml": SEEDED });
  const r = await run({ set, box: box({ resetOn: "UPDATE TLIB.T SET S = 'X'", rows: holds }) }, { verb: "SEEDED" });
  assert.equal(r.s.failed, 1);
  assert.deepEqual(r.sent, ["0: SELECT 1 FROM TLIB.T WHERE K = ?", "0: INSERT INTO TLIB.T (K) VALUES (?)", "1: DELETE FROM TLIB.T WHERE K = ?"]);
  assert.match(r.s.results[0].error, /steps\.0: the connection to the IBM i was reset after this was decided; not sent/);
  assert.match(r.s.results[0].notes.join("\n"), /new job that has lost QTEMP and the library list/);
  // the run log holds the verb's call and the cleanup decided again as a call of its own
  const calls = [...new Set(r.log.map((l) => l.call))];
  assert.equal(calls.length, 2);
  assert.match(r.log.find((l) => l.call === calls[1]).notes.join("\n"), /cleanup of proj:SEEDED decided again after a connection reset/);
});

test("verb_run: what is sent is what was decided: CL continuation lines arrive folded", async () => {
  const { set } = verbs({ "c.yaml": verb("C", "steps:\n  - cl: |\n      CALL PGM(TLIB/P) +\n        PARM('1')\n") });
  const r = await run({ set }, { verb: "C" });
  assert.equal(r.s.passed, 1);
  assert.deepEqual(r.sent, ["0: CALL PGM(TLIB/P) PARM('1')"]);
});

test("verb_run: requires_absent and expect queries that change data are refused before anything runs", async () => {
  const { set } = verbs({ "s.yaml": SEEDED.replace("SELECT 1 FROM TLIB.T WHERE K = :k", "SELECT * FROM OLD TABLE (DELETE FROM TLIB.T WHERE K = :k)") });
  const r = await run({ set }, { verb: "SEEDED" });
  assert.deepEqual(r.sent, []);
  assert.match(r.s.results[0].error, /setup\.0\.requires_absent: a requires_absent query must only read, but it is write TLIB\.T/);
});

test("verb_run: the profile's own guards (read-only, blocked tables, runaway queries) refuse a verb the policy allows", async () => {
  const { set } = verbs({ "s.yaml": SEEDED, "r.yaml": verb("RUNAWAY", "steps:\n  - expect: { sql: SELECT * FROM QSYS2.SYSPARTITIONINDEXSTAT, empty: true }\n") });
  for (const [o, ref, re] of [
    [{ readOnly: true }, "SEEDED", /proj:SEEDED setup\.0: refused: the profile is read-only \(IBMI_READ_ONLY\)/],
    [{ blockedTables: ["tlib.t"] }, "SEEDED", /refused: TLIB\.T is blocked by IBMI_BLOCKED_TABLES/],
    [{}, "RUNAWAY", /proj:RUNAWAY steps\.0\.expect: refused: refusing syspartitionindexstat/],
  ] as const) {
    const r = await run({ set, box: box({ ...o, blockedTables: "blockedTables" in o ? [...o.blockedTables] : [] }) }, { verb: ref });
    assert.deepEqual(r.sent, [], ref);
    assert.match(r.s.results[0].error, re);
  }
});

test("verb_run: every statement of a run is logged with its outcome and the verb's layer and file, never the password", async () => {
  const { set, dir } = verbs({ "s.yaml": SEEDED });
  const r = await run({ set, box: box({ rows: holds }) }, { verb: "SEEDED" });
  assert.equal(r.s.passed, 1);
  assert.deepEqual(r.log.map((l) => [l.tool, l.index, l.identity.user, l.outcome.slice(0, 2)]), [
    ["verb_run", 0, "JDOE", "no"],
    ["verb_run", 1, "JDOE", "ok"],
    ["verb_run", 2, "JDOE", "ok"],
    ["verb_run", 3, "JDOE", "ho"],
    ["verb_run", 4, "JDOE", "ok"],
    ["verb_run", 5, "JDOE", "ok"],
  ]);
  assert.ok(r.log[0].notes.includes(`verb proj:SEEDED from ${join(dir, "s.yaml")}`));
  assert.doesNotMatch(JSON.stringify(r.log), /Secret1x/);
});

// --- the tools ---

const LIVE_WRITE = verb("FIX-ORDERS", "tags: [smoke]\nsteps:\n  - sql: UPDATE LVORD.ORDHDR SET OHSTS = 'V' WHERE OHORD = 1\n");

test("verb tools: an analyst cannot widen access through a project verb", async () => {
  const { set } = verbs({ "f.yaml": LIVE_WRITE });
  const r = await run({ set, policy: D4, box: box({ user: "ANL01", group: "GRPANL", rdb: "PRODRDB" }) }, { verb: "FIX-ORDERS" });
  assert.equal(r.error, true);
  assert.deepEqual(r.sent, []);
  assert.match(r.text, /FAILED proj:FIX-ORDERS: nothing was sent: proj:FIX-ORDERS steps\.0 is denied: no rule matches write LVORD\.ORDHDR \(environment live, partition prod\)/);
});

test("verb tools: policy_check with a verb runs nothing and returns each statement's operations, rule and decision", async () => {
  const { set } = verbs({ "s.yaml": SEEDED });
  const k = await kit({ set, policy: D4 });
  try {
    const r = await k.call("policy_check", { verb: "SEEDED", args: { k: 9 } });
    assert.deepEqual(k.sent, []);
    assert.equal(r.error, false, r.text);
    const st = r.s.statements;
    assert.equal(st.length, 6);
    assert.deepEqual([st[1].verb, st[1].where, st[1].decision, st[1].effective, st[1].operations[0].class, st[1].operations[0].object, st[1].operations[0].env], ["proj:SEEDED", "setup.0", "deny", "allow", "write", "TLIB.T", "unmatched"]);
    assert.deepEqual([r.s.verb, r.s.partition, r.s.user], ["proj:SEEDED", "dev", "JDOE"]);
    assert.match(r.text, /^statement 1 \(proj:SEEDED setup\.0\.requires_absent\): allow/);
    // offline, for a stated identity: nothing reaches the box, not even lookups
    const off = await k.call("policy_check", { verb: "SEEDED", as: { user: "ANL01", groups: ["GRPANL"], partition: "prod" } });
    assert.deepEqual(k.sent, []);
    assert.deepEqual(off.s.statements.map((s: any) => s.decision), ["allow", "deny", "deny", "allow", "deny", "deny"]);
    assert.match((await k.call("policy_check", { verb: "SEEDED", script: "VALUES 1" })).text, /give exactly one of script and verb/);
    assert.match((await k.call("policy_check", { script: "VALUES 1", args: { k: 1 } })).text, /args go with verb/);
  } finally {
    await k.close();
  }
});

test("verb tools: a tag suite continues after a failure, counts each outcome and names missing parameters", async () => {
  const { set } = verbs({
    "a.yaml": verb("A", "tags: [smoke]\nsteps:\n  - sql: DELETE FROM TLIB.BAD\n"),
    "b.yaml": verb("B", "tags: [smoke]\nsteps:\n  - sql: DELETE FROM TLIB.B\n"),
    "c.yaml": verb("C", "tags: [smoke, nightly]\nsteps:\n  - sql: DELETE FROM TLIB.C\n"),
    "d.yaml": verb("D", "tags: [smoke]\nparams:\n  who: { type: string }\nsteps:\n  - sql: DELETE FROM TLIB.D WHERE W = :who\n"),
    "e.yaml": verb("E", "steps:\n  - sql: DELETE FROM TLIB.E\n"),
  });
  const k = await kit({ set, box: box({ fail: ["TLIB.BAD"] }) });
  try {
    const r = await k.call("verb_run", { tag: "smoke" });
    assert.deepEqual([r.s.passed, r.s.failed, r.s.skipped], [2, 1, 1]);
    assert.deepEqual(r.s.results.map((x: any) => [x.verb, x.status]), [["proj:A", "failed"], ["proj:B", "passed"], ["proj:C", "passed"], ["proj:D", "skipped"]]);
    assert.equal(r.s.results[3].error, "skipped: who has no default");
    assert.deepEqual(k.sent, ["0: DELETE FROM TLIB.BAD", "0: DELETE FROM TLIB.B", "0: DELETE FROM TLIB.C"]);
    assert.match((await k.call("verb_run", { verb: "B", tag: "smoke" })).text, /give exactly one of verb and tag/);
    assert.match((await k.call("verb_run", { tag: "none" })).text, /no verb has the tag none/);
  } finally {
    await k.close();
  }
});

// A folder's names and contents, to prove no tool wrote to it.
const snapshot = (dir: string) => readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]);

test("verb tools: verbs load from the project folder, the profile's IBMI_KIT_VERBS (not the environment's) and beside its IBMI_KIT_POLICY; no tool writes verb files", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-verbs-tools-"));
  const proj = join(root, "repo", ".ibmi-kit", "verbs");
  const fromProfile = join(root, "shared");
  const fromEnv = join(root, "env");
  const org = join(root, "policy", "verbs");
  for (const [d, n] of [[proj, "SMOKE-ORDERS"], [fromProfile, "SHARED"], [fromEnv, "SNEAKY"], [org, "TEAM"]]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${n}.yaml`), verb(n, "tags: [smoke]\nsteps:\n  - sql: SELECT * FROM TLIB.T\n"));
  }
  writeFileSync(join(root, "policy", "policy.yaml"), POLICY_TEXT);
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", ".env"), `IBMI_HOST=example.invalid\nIBMI_KIT_VERBS=${fromProfile}\nIBMI_KIT_POLICY=${join(root, "policy", "policy.yaml")}\n`);
  const saved = { ...process.env };
  const cwd = process.cwd();
  Object.assign(process.env, { IBMI_KIT_CONFIG_DIR: join(root, "config"), HOME: join(root, "home"), USERPROFILE: join(root, "home"), IBMI_KIT_VERBS: fromEnv });
  process.chdir(join(root, "repo"));
  const before = [proj, fromProfile, fromEnv, org].map(snapshot);
  // the profile's own policy and profile settings: no policy or profileEnv override
  const b = box();
  const dir = mkdtempSync(join(tmpdir(), "kit-verb-runs-"));
  const k = createServer({ conn: () => b.conn, runLogDir: dir, notice: () => {}, confirmTimeoutMs: 5000, sqlTimeLimitMs: 5000 });
  const c = new Client({ name: "selfcheck", version: "0" });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await Promise.all([k.mcp.connect(y), c.connect(x)]);
  const call = async (name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; structuredContent?: any };
  try {
    const listed = await call("verb_list", {});
    assert.deepEqual(listed.structuredContent.verbs.map((v: any) => v.address), ["org:TEAM", "proj:SHARED", "proj:SMOKE-ORDERS"]);
    assert.match(listed.content[0].text, /proj:SMOKE-ORDERS \[smoke\]: SMOKE-ORDERS test/);
    const suite = await call("verb_run", { tag: "smoke" });
    assert.equal(suite.structuredContent.passed, 3, suite.content[0].text);
    await call("verb_run", { verb: "TEAM" });
    await call("policy_check", { verb: "SHARED" });
    assert.deepEqual([proj, fromProfile, fromEnv, org].map(snapshot), before);
    // no tool takes verb text or a file to write
    const { tools } = await c.listTools();
    for (const t of tools.filter((t) => t.name.startsWith("verb_"))) assert.deepEqual(Object.keys(t.inputSchema.properties ?? {}).filter((p) => !["server", "verb", "args", "tag"].includes(p)), [], t.name);
    assert.equal(tools.find((t) => t.name === "verb_list")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === "verb_run")?.annotations?.destructiveHint, true);
    assert.equal(tools.filter((t) => t.name === "policy_check").length, 1);
  } finally {
    await c.close();
    await shutdownAll(k.engines);
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("policy test: a verb case finds its verb beside the policy and decides each statement", async () => {
  const root = mkdtempSync(join(tmpdir(), "kit-verbs-cli-"));
  copyFileSync(join(EXAMPLES, "three-partitions.yaml"), join(root, "policy.yaml"));
  copyFileSync(join(EXAMPLES, "cm-product.yaml"), join(root, "cm-product.yaml"));
  mkdirSync(join(root, "verbs"));
  writeFileSync(join(root, "verbs", "fix.yaml"), LIVE_WRITE);
  const tests = (expect: string) => `- name: analyst on prod\n  as: { user: ANL01, groups: [GRPANL], partition: prod }\n  verb: FIX-ORDERS\n  expect: ${expect}\n`;
  writeFileSync(join(root, "ok.yaml"), tests("deny"));
  writeFileSync(join(root, "bad.yaml"), tests("allow"));
  const out: string[] = [];
  assert.equal(await policyCli(["test", join(root, "policy.yaml"), join(root, "ok.yaml")], (t) => out.push(t), (t) => out.push(t)), 0, out.join("\n"));
  assert.deepEqual(out, ["1 cases passed"]);
  out.length = 0;
  assert.equal(await policyCli(["test", join(root, "policy.yaml"), join(root, "bad.yaml")], (t) => out.push(t), (t) => out.push(t)), 1);
  assert.match(out[0], /^FAIL analyst on prod: expected allow, got deny\n  statement 1: org:FIX-ORDERS steps\.0: UPDATE LVORD\.ORDHDR/);
});
