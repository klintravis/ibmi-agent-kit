import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, LATEST_PROTOCOL_VERSION, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { builtinPolicy, classify, decide, loadPolicy, parsePolicy, recordLookups, runLogLines, statedLookups, type Policy } from "@ibmi-agent-kit/guard";
import { CONFIRM_TIMEOUT_MS, type Conn } from "./guarded.js";
import { policyCli } from "./policy-cli.js";
import { createServer, listServersText, onceShutdown, shutdownAll, type Engine } from "./server.js";

const BIN = fileURLToPath(new URL("./index.js", import.meta.url));

// Point every profile folder at an empty temp dir, so no real profile on this machine loads.
function emptyConfig() {
  const root = mkdtempSync(join(tmpdir(), "kit-server-"));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("IBMI_")) env[k] = v;
  Object.assign(env, { IBMI_KIT_CONFIG_DIR: join(root, "config"), HOME: root, USERPROFILE: root });
  return { root, env };
}

async function connected() {
  const kit = createServer({ policy: builtinPolicy() }); // reads no profile on this machine
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "selfcheck", version: "0" });
  await Promise.all([kit.mcp.connect(serverSide), client.connect(clientSide)]);
  return { kit, client };
}

test("the kit server lists both engines' tools and one list_servers", async () => {
  const { kit, client } = await connected();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["session_open", "screen_do", "run_sql", "compile_member", "list_servers"]) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
    assert.equal(names.filter((n) => n === "list_servers").length, 1);
    assert.equal(new Set(names).size, names.length, "a tool name appears twice");

    const ann = (n: string) => tools.find((t) => t.name === n)?.annotations;
    for (const n of ["run_sql", "list_servers", "policy_check"]) assert.equal(ann(n)?.readOnlyHint, true, n);
    for (const n of ["compile_member", "upload_source_member", "screen_do", "run_script"]) {
      assert.equal(ann(n)?.destructiveHint, true, n);
    }
    for (const t of tools) assert.ok(t.annotations?.title || t.title, `${t.name} has no title`);
  } finally {
    await client.close();
    await shutdownAll(kit.engines);
  }
});

test("list_servers names the profile folders and no sessions when none are open", async () => {
  const { root, env } = emptyConfig();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const k of Object.keys(process.env)) if (k.startsWith("IBMI_") && !(k in env)) delete process.env[k];
  const { kit, client } = await connected();
  try {
    const res = await client.callTool({ name: "list_servers", arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0].text;
    assert.match(text, /^Servers: none configured/);
    assert.match(text, /first match wins/);
    assert.ok(text.includes(join(root, "config")), text);
    assert.match(text, /No profiles found. Copy .env.example as .env or .env.<name> into/);
    assert.doesNotMatch(text, /Open 5250 sessions/);
    // An open session is listed under its server, even once that profile file is gone.
    const withSessions = listServersText([
      { server: "gone", session: "main" },
      { server: "gone", session: "s2", closed: true },
    ]);
    assert.ok(withSessions.includes("Open 5250 sessions:\n  gone (no profile): main, s2 (closed)\n"), withSessions);
    assert.match(withSessions, /\nKeys: .*Enter/, withSessions);
  } finally {
    await client.close();
    await shutdownAll(kit.engines);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tool name registered twice stops startup, naming the tool", () => {
  assert.throws(
    () =>
      createServer({
        extra: (mcp) => void mcp.registerTool("run_sql", { description: "duplicate" }, async () => ({ content: [] })),
      }),
    /run_sql/,
  );
});

test("shutdown runs every engine and returns within the bound when one never settles", async () => {
  const calls: string[] = [];
  const engines: Engine[] = [
    { shutdown: () => (calls.push("hung"), new Promise<void>(() => {})) },
    { shutdown: async () => void calls.push("quick") },
  ];
  const t0 = Date.now();
  await shutdownAll(engines);
  const took = Date.now() - t0;
  assert.deepEqual(calls.sort(), ["hung", "quick"]);
  assert.ok(took >= 4900 && took < 6000, `took ${took} ms`);
});

test("a rejecting engine does not cut the other's shutdown short", async () => {
  let finished = false;
  await shutdownAll(
    [
      { shutdown: async () => { throw new Error("boom"); } },
      { shutdown: () => new Promise<void>((done) => setTimeout(() => ((finished = true), done()), 50)) },
    ],
    1000,
  );
  assert.ok(finished);
});

test("every trigger after the first is ignored: one shutdown, one exit", async () => {
  let shutdowns = 0;
  const exits: number[] = [];
  const stop = onceShutdown([{ shutdown: async () => void shutdowns++ }], (c) => exits.push(c), 1000);
  await Promise.all([stop("SIGINT"), stop("stdin end"), stop("transport closed")]);
  await stop("SIGTERM");
  assert.equal(shutdowns, 1);
  assert.deepEqual(exits, [0]);
});

test("the bin speaks only JSON-RPC on stdout and exits when stdin closes", { timeout: 30000 }, async () => {
  const { root, env } = emptyConfig();
  const child = spawn(process.execPath, [BIN], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const messages: { id?: number; result?: { tools?: { name: string }[] } }[] = [];
  const waiters = new Map<number, () => void>();
  let pending = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    pending += d;
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      const msg = JSON.parse(line); // throws, failing the test, on anything that is not JSON
      assert.equal(msg.jsonrpc, "2.0", line);
      messages.push(msg);
      if (typeof msg.id === "number") waiters.get(msg.id)?.();
    }
  });
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const reply = (id: number) =>
    new Promise<void>((done, fail) => {
      waiters.set(id, done);
      setTimeout(() => fail(new Error(`no reply to ${id}; stderr:\n${stderr}`)), 15000).unref();
    });

  try {
    const init = reply(1);
    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "selfcheck", version: "0" } },
    });
    await init;
    send({ method: "notifications/initialized" });
    const listed = reply(2);
    send({ id: 2, method: "tools/list", params: {} });
    await listed;

    const names = messages.find((m) => m.id === 2)?.result?.tools?.map((t) => t.name) ?? [];
    for (const n of ["session_open", "screen_do", "run_sql", "compile_member", "list_servers"]) {
      assert.ok(names.includes(n), `missing ${n}`);
    }

    const t0 = Date.now();
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<"timeout">((d) => setTimeout(() => d("timeout"), 6000).unref())]);
    assert.notEqual(code, "timeout", `still running 6 s after stdin closed; stderr:\n${stderr}`);
    assert.equal(code, 0, stderr);
    assert.ok(Date.now() - t0 < 6000);
    assert.equal(pending, "", "a partial line was left on stdout");
    assert.match(stderr, /\[ibmi-agent-kit\] shutting down \(stdin end\)/);
    assert.match(stderr, /\[ibmi-agent-kit\] shutdown complete/);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- policy CLI (policy-testing spec; tasks 3.1, 3.2) ---

const EXAMPLES = fileURLToPath(new URL("../../../examples/", import.meta.url));

function runBin(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

test("policy test: the example suite passes and exits 0, without starting MCP", async () => {
  const r = await runBin(["policy", "test", join(EXAMPLES, "three-partitions.yaml"), join(EXAMPLES, "three-partitions.tests.yaml")]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^\d+ cases passed\r?\n$/);
  assert.doesNotMatch(r.stderr, /MCP server ready/);
});

test("policy test: a mutated policy names the failing case and the rule, and exits 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-policy-"));
  try {
    const text = readFileSync(join(EXAMPLES, "three-partitions.yaml"), "utf8");
    writeFileSync(join(dir, "policy.yaml"), text.replace("{ env: blocked, decision: deny }", "{ env: blocked, decision: allow }"));
    copyFileSync(join(EXAMPLES, "cm-product.yaml"), join(dir, "cm-product.yaml"));
    const r = await runBin(["policy", "test", join(dir, "policy.yaml"), join(EXAMPLES, "three-partitions.tests.yaml")]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL analyst blocked: expected deny, got allow/);
    assert.match(r.stdout, /rule 2 allows read PAYLIB\.T/);
    assert.match(r.stdout, /4 of \d+ cases failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy test: usage and load errors exit 2", async () => {
  assert.equal(await policyCli(["test", "only-one"], () => {}, () => {}), 2);
  const err: string[] = [];
  assert.equal(await policyCli(["test", join(EXAMPLES, "nope.yaml"), join(EXAMPLES, "three-partitions.tests.yaml")], () => {}, (t) => err.push(t)), 2);
  assert.match(err.join("\n"), /policy file not found/);
});

test("policy replay: lists what a candidate changes in the run log; --since leaves older days out", async () => {
  const { root, env } = emptyConfig();
  try {
    const policyPath = join(EXAMPLES, "three-partitions.yaml");
    const d4 = loadPolicy(policyPath);
    const runs = join(root, "config", "runs");
    mkdirSync(runs, { recursive: true });
    const who = { user: "JDOE", groups: ["GRPDEV"], authlists: [], partition: "dev" };
    for (const time of [new Date(Date.now() - 30 * 86_400_000), new Date()]) {
      const { lookups, answers } = recordLookups(statedLookups());
      const c = await classify("DELETE FROM INORD.T", { lookups, commands: d4.commands, rdbs: d4.rdbs });
      const statements = c.statements.map((s) => ({ statement: s, decision: decide(s.operations, who, d4), outcome: "1 row" }));
      const lines = runLogLines({ server: "dev1", tool: "run_script", identity: who, lookups: answers, statements, time }, d4);
      writeFileSync(join(runs, `${lines[0].time.slice(0, 10)}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
    writeFileSync(join(runs, "notes.txt"), "not a log file");
    // Lines that are not run-log lines: counted and named on stderr, never replayed.
    const good = JSON.parse(readFileSync(join(runs, `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8").split("\n")[0]);
    const broken = [{ ...good, time: "yesterday" }, { ...good, index: "0" }, { ...good, decision: "maybe" }, { ...good, effective: undefined }];
    // A call whose first line is missing: replayed calls go on, this one is skipped and counted.
    appendFileSync(join(runs, `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ ...good, call: "lost-first-line", index: 1 }) + "\n");
    writeFileSync(join(runs, "2000-01-01.jsonl"), [...broken.map((l) => JSON.stringify(l)), "{not json"].join("\n") + "\n");
    const candidate = join(root, "candidate.yaml");
    writeFileSync(candidate, readFileSync(policyPath, "utf8").replace("partition: dev, env: [personal, devlibs, integ]", "partition: dev, env: [personal, devlibs]"));
    copyFileSync(join(EXAMPLES, "cm-product.yaml"), join(root, "cm-product.yaml"));

    const all = await runBin(["policy", "replay", candidate], env);
    assert.equal(all.code, 0, all.stdout + all.stderr);
    assert.match(all.stdout, /JDOE dev1 run_script partition dev: DELETE FROM INORD\.T\r?\n  allow by rule 6 -> deny \(runs: allow\)\r?\n/);
    assert.match(all.stdout, /2 of 2 statements change under .*; 1 calls skipped \(see stderr\)/);
    assert.match(all.stderr, /skipped call lost-first-line .*a line is missing/);
    assert.match(all.stderr, /skipped 5 unreadable line\(s\)/);
    const recent = await runBin(["policy", "replay", candidate, "--since", "14"], env);
    assert.match(recent.stdout, /1 of 1 statements change/);
    assert.doesNotMatch(recent.stderr, /unreadable/, "day files before the cutoff are not read");
    const same = await runBin(["policy", "replay", policyPath], env);
    assert.match(same.stdout, /^0 of 2 statements change/);
    const bad = await runBin(["policy", "replay", candidate, "--since", "two"], env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--since takes a whole number of days/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- guarded tools (guarded-tools spec; tasks 5.1-5.3) ---

const D4_PATH = join(EXAMPLES, "three-partitions.yaml");
const D4 = loadPolicy(D4_PATH);
const D4_ENFORCE = parsePolicy(readFileSync(D4_PATH, "utf8").replace("mode: { default: observe, prod: enforce }", "mode: enforce"), D4_PATH);
const CONFIRM_POLICY = parsePolicy("version: 1\nmode: enforce\nrules:\n  - { classes: [danger], decision: deny }\n  - { classes: [write], decision: confirm }\n  - { decision: allow }\n", "confirm.yaml");

type Row = Record<string, unknown>;
// A box: answers the guard's own queries, records every script statement that reaches it.
function stubConn(o: { rdb?: string; user?: string; userInfo?: Row | null; authlists?: string[]; readOnly?: boolean; blockedTables?: string[]; failOn?: string; resetOn?: string } = {}) {
  const sent: string[] = [];
  const queries: string[] = [];
  const own = (sql: string): Row[] | undefined => {
    if (sql.startsWith("SELECT CURRENT SERVER")) return [{ RDB: o.rdb ?? "DEVRDB", USR: o.user ?? "JDOE" }];
    if (sql.includes("QSYS2.USER_INFO")) return o.userInfo === null ? [] : [o.userInfo ?? { G: "GRPDEV", S: "" }];
    if (sql.includes("AUTHORIZATION_LIST_USER_INFO")) return (o.authlists ?? []).map((a) => ({ A: a }));
    if (/QSYS2\.(SYSSCHEMAS|SYSTABLES|LIBRARY_LIST_INFO)/.test(sql)) return [];
    return undefined;
  };
  const run = (sql: string) => {
    sent.push(sql);
    if (o.resetOn && sql.includes(o.resetOn)) conn.generation!++; // the job dropped and was reopened
    if (o.failOn && sql.includes(o.failOn)) throw new Error(`SQL0204 ${o.failOn} not found`);
  };
  const conn: Conn = {
    generation: 0,
    profile: { user: o.user ?? "JDOE", password: "Secret1x", readOnly: o.readOnly ?? false, blockedTables: o.blockedTables ?? [], blockedCl: [] },
    async query(sql, _params, maxRows = 100) {
      const rows = own(sql);
      if (rows) {
        queries.push(sql);
        return { rows, columns: [], truncated: false };
      }
      run(sql);
      const data = [{ A: 1 }, { A: 2 }, { A: 3 }];
      return { rows: data.slice(0, maxRows), columns: [{ name: "A" }], truncated: data.length > maxRows };
    },
    async execute(sql) {
      run(sql);
      return { rowsAffected: 1, messages: [] };
    },
    async cl(command) {
      run(command);
      return { ok: true, messages: [] };
    },
  };
  return { conn, sent, queries };
}

async function guardedKit(o: { policy?: Policy; stub?: ReturnType<typeof stubConn>; system?: string; elicit?: (req: any) => Promise<ElicitResult>; timeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kit-runs-"));
  const notices: string[] = [];
  const stub = o.stub ?? stubConn();
  const kit = createServer({
    policy: o.policy ?? builtinPolicy(),
    conn: () => stub.conn,
    profileEnv: () => ({}),
    systemName: () => o.system,
    runLogDir: dir,
    confirmTimeoutMs: o.timeoutMs ?? 5000,
    notice: (m) => notices.push(m),
  });
  const client = new Client({ name: "selfcheck", version: "0" }, o.elicit ? { capabilities: { elicitation: { form: {} } } } : undefined);
  if (o.elicit) client.setRequestHandler(ElicitRequestSchema, o.elicit);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([kit.mcp.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: (r.content as { text: string }[])[0].text, s: r.structuredContent as any };
  };
  const log = () => readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const close = async () => {
    await client.close();
    await shutdownAll(kit.engines);
    rmSync(dir, { recursive: true, force: true });
  };
  return { call, log, notices, stub, close };
}

test("5.1: a profile named dev on a box whose RDB maps to prod decides as prod, and policy_check sends only lookups", async () => {
  const k = await guardedKit({ policy: D4, stub: stubConn({ rdb: "PRODRDB" }) });
  try {
    const { s, error } = await k.call("policy_check", { script: "DELETE FROM INORD.T WHERE K = 1", server: "dev" });
    assert.equal(error, false);
    assert.equal(s.partition, "prod");
    assert.equal(s.statements[0].effective, "deny");
    assert.equal(s.statements[0].operations[0].partition, "prod");
    assert.deepEqual(k.stub.sent, [], "nothing but lookups reaches the box");
    assert.ok(k.stub.queries.every((q) => !q.includes("INORD") && !q.startsWith("DELETE")), k.stub.queries.join("\n"));
  } finally {
    await k.close();
  }
});

test("5.1: System and RDB names that disagree deny everything, naming both partitions", async () => {
  const k = await guardedKit({ policy: D4, stub: stubConn({ rdb: "QARDB" }), system: "devbox" });
  try {
    const { s } = await k.call("policy_check", { script: "SELECT * FROM LVORD.T" });
    assert.match(s.conflict, /System DEVBOX, RDB QARDB map to different partitions: dev and qa/);
    assert.equal(s.statements[0].operations[0].reason, "partition_conflict");
    const r = await k.call("run_script", { script: "SELECT * FROM LVORD.T" });
    assert.equal(r.error, true);
    assert.deepEqual(k.stub.sent, []);
  } finally {
    await k.close();
  }
});

test("5.1: no USER_INFO row falls back to default_role, logged as such; the identity is read once per server", async () => {
  const k = await guardedKit({ policy: D4, stub: stubConn({ userInfo: null }) });
  try {
    await k.call("run_script", { script: "SELECT * FROM LVORD.T" });
    await k.call("run_script", { script: "SELECT * FROM LVORD.U" });
    const [line] = k.log();
    assert.deepEqual(line.roles, ["analyst"]);
    assert.equal(line.roleSource, "default_lookup_failed");
    assert.equal(line.effective, "allow");
    assert.deepEqual(line.names, { rdb: "DEVRDB" });
    assert.match(line.notes.join("\n"), /USER_INFO has no row for JDOE/);
    assert.equal(k.stub.queries.filter((q) => q.startsWith("SELECT CURRENT SERVER")).length, 1);
  } finally {
    await k.close();
  }
});

test("5.1: a role held through an authorization list is found", async () => {
  const k = await guardedKit({ policy: D4, stub: stubConn({ userInfo: { G: "*NONE", S: "" }, authlists: ["AUTLQA"] }) });
  try {
    const { s } = await k.call("policy_check", { script: "SELECT * FROM LVORD.T" });
    assert.deepEqual(s.roles, ["qa"]);
  } finally {
    await k.close();
  }
});

test("5.2: one denied statement sends nothing and names the statement and the rule", async () => {
  const k = await guardedKit({ policy: D4_ENFORCE });
  try {
    const r = await k.call("run_script", { script: "SELECT * FROM LVORD.T;\nDELETE FROM INORD.T WHERE K = 1;\nDELETE FROM PAYLIB.T" });
    assert.equal(r.error, true);
    assert.deepEqual(k.stub.sent, []);
    assert.match(r.text, /statement 3 \(DELETE FROM PAYLIB\.T\): rule 2 denies write PAYLIB\.T/);
    assert.match(r.text, /Ask the user how to proceed; do not try another route/);
    assert.match(r.text, /IBM i authority remains the real boundary/);
    assert.deepEqual(r.s.statements.map((x: any) => x.outcome), ["not sent", "not sent", "denied"]);
    assert.deepEqual(k.log().map((l) => l.outcome.split(":")[0]), ["not sent", "not sent", "denied"]);
  } finally {
    await k.close();
  }
});

test("5.2: with no policy file, FROBCMD X runs observed, but next to PWRDWNSYS nothing is sent", async () => {
  const k = await guardedKit();
  try {
    const r = await k.call("run_script", { script: "CL: FROBCMD X\nCL: PWRDWNSYS OPTION(*IMMED)" });
    assert.equal(r.error, true);
    assert.deepEqual(k.stub.sent, []);
    const ok = await k.call("run_script", { script: "CL: FROBCMD X" });
    assert.equal(ok.error, false, ok.text);
    assert.deepEqual(k.stub.sent, ["FROBCMD X"]);
    const line = k.log().find((l) => l.outcome === "ok");
    assert.equal(line.decision, "deny");
    assert.equal(line.enforced, false);
    assert.equal(line.operations[0].reason, "unknown_command");
  } finally {
    await k.close();
  }
});

test("5.2: an unmapped CONNECT then a DELETE sends nothing", async () => {
  const k = await guardedKit();
  try {
    const r = await k.call("run_script", { script: "CONNECT TO OTHERDB;\nDELETE FROM MYLIB.T WHERE K = 1" });
    assert.equal(r.error, true);
    assert.deepEqual(k.stub.sent, []);
  } finally {
    await k.close();
  }
});

test("5.2: a failure stops later statements; rows are bounded by maxRows", async () => {
  const k = await guardedKit({ stub: stubConn({ failOn: "MYLIB.B" }) });
  try {
    const r = await k.call("run_script", { script: "INSERT INTO MYLIB.A VALUES 1;\nINSERT INTO MYLIB.B VALUES 2;\nINSERT INTO MYLIB.C VALUES 3" });
    assert.equal(r.error, true);
    assert.deepEqual(k.stub.sent, ["INSERT INTO MYLIB.A VALUES 1", "INSERT INTO MYLIB.B VALUES 2"]);
    assert.deepEqual(r.s.statements.map((x: any) => x.outcome), ["ok", "failed", "not sent"]);
    assert.match(r.s.statements[1].error, /SQL0204/);
    const q = await k.call("run_script", { script: "SELECT * FROM MYLIB.T", maxRows: 2 });
    assert.deepEqual(q.s.statements[0].rows, [{ A: 1 }, { A: 2 }]);
    assert.equal(q.s.statements[0].truncated, true);
    const big = await k.call("run_script", { script: "SELECT * FROM MYLIB.T", maxRows: 1001 }).catch(() => ({ error: true }));
    assert.equal(big.error, true);
  } finally {
    await k.close();
  }
});

test("5.2: a read-only profile refuses an update the policy allows; blocked tables are refused", async () => {
  const k = await guardedKit({ stub: stubConn({ readOnly: true, blockedTables: ["secret"] }) });
  try {
    const r = await k.call("run_script", { script: "UPDATE MYLIB.T SET C = 1 WHERE K = 1" });
    assert.equal(r.error, true);
    assert.match(r.text, /IBMI_READ_ONLY/);
    const b = await k.call("run_script", { script: "SELECT * FROM MYLIB.SECRET" });
    assert.match(b.text, /SECRET is blocked by IBMI_BLOCKED_TABLES/);
    assert.deepEqual(k.stub.sent, []);
  } finally {
    await k.close();
  }
});

test("5.2: policy_check with policy and as decides offline and sends nothing; policy alone is refused", async () => {
  const stub = stubConn();
  const k = await guardedKit({ stub });
  try {
    const { s, text } = await k.call("policy_check", {
      script: "DELETE FROM INLIB1.ORD WHERE K = 1",
      policy: D4_PATH,
      as: { user: "JDOE", groups: ["GRPDEV"], partition: "dev" },
    });
    const op = s.statements[0].operations[0];
    assert.deepEqual([op.class, op.object, op.env, op.rule, s.statements[0].decision], ["write", "INLIB1.ORD", "integ", 6, "allow"]);
    assert.match(text, /IBM i authority remains the real boundary/);
    assert.deepEqual(stub.queries, []);
    assert.deepEqual(stub.sent, []);
    const bad = await k.call("policy_check", { script: "SELECT 1 FROM A.T", policy: D4_PATH });
    assert.equal(bad.error, true);
    assert.match(bad.text, /state the identity in `as`/);
  } finally {
    await k.close();
  }
});

const SCRIPT = "DELETE FROM MYLIB.A WHERE K = 1; -- tidy up\nSELECT * FROM MYLIB.B;\nDELETE FROM MYLIB.C WHERE K = 2";

test("5.3: a client without elicitation gets a deny saying so, and the startup notice says so", async () => {
  const k = await guardedKit({ policy: CONFIRM_POLICY });
  try {
    const r = await k.call("run_script", { script: SCRIPT });
    assert.equal(r.error, true);
    assert.match(r.text, /confirmation is unavailable in this client/);
    assert.deepEqual(k.stub.sent, []);
    assert.ok(k.notices.some((n) => /confirmation is unavailable in this client/.test(n)), k.notices.join("\n"));
    assert.equal(CONFIRM_TIMEOUT_MS, 120_000);
  } finally {
    await k.close();
  }
});

test("5.3: accept with confirm true runs everything after one question, logged confirmed", async () => {
  const asked: string[] = [];
  const k = await guardedKit({
    policy: CONFIRM_POLICY,
    elicit: async (req) => (asked.push(req.params.message), { action: "accept", content: { confirm: true } }),
  });
  try {
    const r = await k.call("run_script", { script: SCRIPT });
    assert.equal(r.error, false, r.text);
    assert.equal(asked.length, 1);
    assert.equal(k.stub.sent.length, 3);
    const m = asked[0];
    assert.ok(m.indexOf("write MYLIB.A") < m.indexOf("DELETE FROM MYLIB.A WHERE K = 1"), m);
    assert.match(m, /Statement 3:/);
    assert.doesNotMatch(m, /tidy up|Statement 2:/);
    assert.deepEqual(k.log().map((l) => l.confirmed), [true, undefined, true]);
    assert.ok(k.notices.some((n) => /confirmation is available/.test(n)));
  } finally {
    await k.close();
  }
});

const ANSWERS: [string, () => Promise<ElicitResult>][] = [
  ["accept with confirm false", async () => ({ action: "accept", content: { confirm: false } })],
  ["decline", async () => ({ action: "decline" })],
  ["no answer before the timeout", () => new Promise<never>(() => {})],
];
for (const [name, answer] of ANSWERS) {
  test(`5.3: ${name} sends nothing`, async () => {
    const k = await guardedKit({ policy: CONFIRM_POLICY, elicit: answer, timeoutMs: 100 });
    try {
      const r = await k.call("run_script", { script: SCRIPT });
      assert.equal(r.error, true);
      assert.match(r.text, /Denied, nothing was sent/);
      assert.deepEqual(k.stub.sent, []);
      assert.deepEqual(k.log().map((l) => l.confirmed), [false, undefined, false]);
    } finally {
      await k.close();
    }
  });
}

test("5.2: a connection reset after the script was decided stops it and says so", async () => {
  const k = await guardedKit({ stub: stubConn({ resetOn: "MYLIB.B" }) });
  try {
    const r = await k.call("run_script", { script: "INSERT INTO MYLIB.A VALUES 1;\nINSERT INTO MYLIB.B VALUES 2;\nINSERT INTO MYLIB.C VALUES 3" });
    assert.equal(r.error, true);
    assert.deepEqual(k.stub.sent, ["INSERT INTO MYLIB.A VALUES 1", "INSERT INTO MYLIB.B VALUES 2"]);
    assert.deepEqual(r.s.statements.map((x: any) => x.outcome), ["ok", "ok", "not sent"]);
    assert.match(r.text, /reset after the script was decided/);
  } finally {
    await k.close();
  }
});

test("5.1: each profile's IBMI_KIT_POLICY is loaded at startup; a missing one refuses to start; the environment's is ignored", async () => {
  const { root, env } = emptyConfig();
  const saved = { ...process.env };
  const config = join(root, "config");
  const missing = join(root, "nope.yaml");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, ".env.dev"), `IBMI_HOST=h\nIBMI_USER=JDOE\nIBMI_PASSWORD=p\nIBMI_KIT_POLICY=${D4_PATH}\n`);
  writeFileSync(join(config, ".env.bad"), `IBMI_HOST=h\nIBMI_KIT_POLICY=${missing}\n`);
  Object.assign(process.env, env);
  for (const k of Object.keys(process.env)) if (k.startsWith("IBMI_") && !(k in env)) delete process.env[k];
  try {
    assert.throws(() => createServer(), (e: Error) => e.message.includes(missing));
    rmSync(join(config, ".env.bad"));
    process.env.IBMI_KIT_POLICY = missing; // a registration's environment cannot pick or drop the policy
    const stub = stubConn();
    const kit = createServer({ conn: () => stub.conn, runLogDir: join(root, "runs"), notice: () => {} });
    const client = new Client({ name: "selfcheck", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([kit.mcp.connect(b), client.connect(a)]);
    try {
      const r = await client.callTool({ name: "policy_check", arguments: { script: "DELETE FROM INLIB1.ORD", server: "dev", as: { user: "JDOE", groups: ["GRPDEV"], partition: "dev" } } });
      const s = r.structuredContent as any;
      assert.equal(s.policy, D4_PATH);
      assert.equal(s.statements[0].operations[0].rule, 6);
    } finally {
      await client.close();
      await shutdownAll(kit.engines);
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
