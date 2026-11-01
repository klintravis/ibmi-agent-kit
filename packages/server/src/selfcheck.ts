import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfileEnv } from "@ibmi-agent-kit/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, LATEST_PROTOCOL_VERSION, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { builtinPolicy, classify, decide, loadPolicy, parsePolicy, recordLookups, replayRunLog, runLogLines, statedLookups, type Policy } from "@ibmi-agent-kit/guard";
import { MapepireBackend } from "@ibmi-agent-kit/source/tools";
import { Session } from "@ibmi-agent-kit/screen/tools";
import { CONFIRM_TIMEOUT_MS, supplementalGroups, toolStatements, type Conn } from "./guarded.js";
import { policyCli } from "./policy-cli.js";
import { createServer, listServersText, onceShutdown, shutdownAll, type Engine, type ServerDeps } from "./server.js";
import "./verbs-selfcheck.js"; // project-verbs runner and tools
import "./setup-selfcheck.js"; // the setup command

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

test("setup: the real binary refuses when stdin is not a terminal and writes nothing", async () => {
  const { root, env } = emptyConfig();
  try {
    const r = await runBin(["setup", "demo"], env);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /needs a real terminal/);
    assert.equal(existsSync(join(root, "config")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// demo-quickstart: the demo policies pass their own tests, so docs/demo.md cannot drift.
test("policy test: both demo policies pass their tests", async () => {
  for (const p of ["observe", "enforce"]) {
    const r = await runBin(["policy", "test", join(EXAMPLES, `demo/policy-${p}.yaml`), join(EXAMPLES, `demo/${p}.tests.yaml`)]);
    assert.equal(r.code, 0, p + "\n" + r.stdout + r.stderr);
  }
});

// showcase-demo 1.3: part E's verbs (org layer beside the demo policies) and its session call pass both demo policies.
test("policy test: both demo policies pass their showcase tests, verbs load without warnings", async () => {
  for (const p of ["observe", "enforce"]) {
    const r = await runBin(["policy", "test", join(EXAMPLES, `demo/policy-${p}.yaml`), join(EXAMPLES, `demo/showcase-${p}.tests.yaml`)]);
    assert.equal(r.code, 0, p + "\n" + r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /warning:/, p);
  }
});

test("showcase: the upload into MYLIB/SEEDSRC and the session on MYLIB/SEEDLST are allowed for the owner", async () => {
  const calls: [string, Record<string, unknown>][] = [
    ["upload_source_member", { library: "MYLIB", sourceFile: "SEEDSRC", member: "SEEDLST" }],
    ["session_open", { program: "MYLIB/SEEDLST", library: "MYLIB" }],
  ];
  for (const p of ["observe", "enforce"]) {
    const policy = loadPolicy(join(EXAMPLES, `demo/policy-${p}.yaml`));
    for (const [tool, input] of calls) {
      const { statements } = await toolStatements(tool, input, policy, statedLookups(), async () => undefined);
      assert.ok(statements.length > 0, `${p} ${tool}`);
      for (const s of statements) assert.equal(decide(s.operations, { user: "MYUSER", partition: "demo" }, policy).decision, "allow", `${p} ${tool}: ${s.display}`);
    }
  }
});

// showcase-demo 2.4: the shipped members are exactly what SEED-BUILD compiles, the DDS keeps its columns, no member names a library.
test("showcase: every SEED-BUILD member has a source file, DDS columns hold, no library named", () => {
  const src = join(EXAMPLES, "showcase/src");
  const files = readdirSync(src);
  const members = files.map((f) => f.replace(/\.[^.]+$/, "").toUpperCase()).sort();
  const build = readFileSync(join(EXAMPLES, "demo/verbs/SEED-BUILD.yaml"), "utf8");
  const wanted = [...build.matchAll(/SRCMBR\((\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual(wanted.sort(), ["SEEDDSPF", "SEEDLST", "SEEDS", "SEEDSRV", "SEEDTST"]);
  assert.deepEqual(members, [...wanted, "SEEDPR"].sort());
  for (const f of files) {
    const text = readFileSync(join(src, f), "utf8");
    assert.doesNotMatch(text, /MYLIB|QGPL/i, f);
    const lines = text.replace(/\n$/, "").split("\n");
    // RCDLEN(112) in SEED-PREP leaves 100 characters of source per line
    for (const l of lines) assert.ok(l.length <= 100, `${f}: line over 100: ${l}`);
    if (!/\.(pf|dspf)$/.test(f)) continue;
    for (const l of lines) {
      if (l[6] === "*") continue;
      assert.equal(l[5], "A", `${f}: no A in column 6: ${l}`);
      assert.ok(l.length <= 80, `${f}: line over 80: ${l}`);
    }
  }
});

// showcase-demo 3.2: the screen tests parse and run as shipped inside the demo's session: no command typed, no library.
test("showcase: both screen tests parse, type no CALL and name no library", async () => {
  const dir = join(EXAMPLES, "showcase/screen-tests");
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["01-list.md", "02-detail.md"]);
  const { parseTest } = await import(new URL("../../screen/dist/testrun.js", import.meta.url).href);
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.ok(parseTest(text, f).steps.length > 0, f);
    assert.doesNotMatch(text, /CALL|MYLIB/, f);
  }
});

// demo-quickstart 3: the /demo skill names only real tools and paths, and its connection query is a read.
test("demo skill: frontmatter, tool names, repo paths and the connection SELECT are valid", async () => {
  const root = join(EXAMPLES, "..");
  const md = readFileSync(join(root, ".claude/skills/demo/SKILL.md"), "utf8");
  assert.match(md, /^---\nname: demo\n/);
  for (const s of ["dist/index.js setup <name>", "claude mcp get ibmi-agent-kit", "reset-project-choices", "disabledMcpjsonServers"]) assert.ok(md.includes(s), `SKILL.md lacks ${s}`);
  const guide = readFileSync(join(root, "docs/demo.md"), "utf8");
  for (const s of ["IBMI_5250_VIEWER", "IBMI_5250_VIEWER_PORT"]) assert.ok(guide.includes(s), `docs/demo.md lacks ${s}`);
  const refuse = readFileSync(join(root, ".claude/skills/ibmi-kit-config/SKILL.md"), "utf8");
  for (const s of ["`package.json`", "`packages/`"]) assert.ok(refuse.includes(s), `ibmi-kit-config lacks ${s}`);
  const desc = md.match(/^description: (.*)$/m)![1];
  for (const p of ["demo", "quick start", "try the kit", "set up my connection"]) assert.ok(desc.includes(`"${p}"`), p);
  const { kit, client } = await connected();
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["list_servers", "run_sql", "run_script", "policy_check", "verb_list", "verb_run"]) assert.ok(names.includes(n), `missing ${n}`);
    for (const m of md.matchAll(/`([a-z]+_[a-z_]+)`/g)) assert.ok(names.includes(m[1]), `${m[1]} is not a tool`);
  } finally {
    await client.close();
    await shutdownAll(kit.engines);
  }
  for (const m of md.matchAll(/`(?:<kit>\/)?((?:docs|packages|examples|templates|\.claude)\/[^`<>~ ]+|README\.md)`/g)) {
    assert.ok(existsSync(join(root, m[1])), `${m[1]} does not exist`);
  }
  const q = md.match(/`(SELECT [^`]+)`/)![1];
  const { assertSelectOnly } = await import(new URL("../../source/dist/util.js", import.meta.url).href);
  assert.doesNotThrow(() => assertSelectOnly(q), q);
  const c = await classify(q, { lookups: statedLookups() });
  assert.ok(c.operations.length > 0 && c.operations.every((o) => o.class === "read"), q);
  assert.doesNotMatch(md, /\b(CREATE|DROP|INSERT)\b/);
});

// config-bootstrap: every shipped template loads and passes its own tests, so none drifts from the format.
test("policy templates: each loads, is in observe mode and passes its tests", async () => {
  const dir = join(EXAMPLES, "../templates/policies/");
  const names = readdirSync(dir).filter((f) => f.endsWith(".yaml") && !f.endsWith(".tests.yaml"));
  assert.equal(names.length, 4, names.join(", "));
  for (const f of names) {
    const policy = join(dir, f);
    assert.equal(loadPolicy(policy).mode.default, "observe", f);
    const r = await runBin(["policy", "test", policy, policy.replace(/\.yaml$/, ".tests.yaml")]);
    assert.equal(r.code, 0, `${f}\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /warning:/, f);
  }
});

// config-bootstrap 2.3: the ibmi-kit-config dry-run's policy carries its fixture's names and passes its own tests.
test("policy templates: the bootstrap dry-run's policy matches its discovery fixture and passes its tests", async () => {
  const dir = join(EXAMPLES, "../templates/dry-run/");
  const { servers } = JSON.parse(readFileSync(join(dir, "discovery.json"), "utf8"));
  const policy = loadPolicy(join(dir, "policy.yaml"));
  assert.deepEqual(policy.mode, { default: "observe", partitions: {} });
  assert.deepEqual(policy.partitions.map((p) => p.name), Object.keys(servers));
  for (const p of policy.partitions) {
    const q = servers[p.name];
    assert.deepEqual(p.systems, [q.S3[0].HOST_NAME], p.name);
    assert.deepEqual(p.rdbs, [q.S1[0].RDB, ...(q.S5 ?? []).map((a: { RDB_NAME: string }) => a.RDB_NAME)], p.name);
  }
  const groups = servers.dev.I1.map((g: { GROUP_PROFILE_NAME: string }) => g.GROUP_PROFILE_NAME);
  for (const r of policy.roles) for (const g of r.groups) assert.ok(groups.includes(g), `${r.name}: ${g} not in I1`);
  // Every role x environment has a case "<role> <env>" holding an allow and a deny.
  const tests = readFileSync(join(dir, "policy.tests.yaml"), "utf8");
  const expects = new Map([...tests.matchAll(/^- name: (.+)\n(?:(?!- name:)[\s\S])*?^ {2}expect: \[(.*)\]/gm)].map((m) => [m[1], m[2].split(/,\s*/)]));
  for (const role of policy.roles) for (const env of policy.environments) {
    const e = expects.get(`${role.name} ${env.name}`);
    assert.ok(e, `no case "${role.name} ${env.name}"`);
    assert.ok(e.includes("allow") && e.includes("deny"), `"${role.name} ${env.name}" needs an allow and a deny: ${e}`);
  }
  // Profile skeletons: one per partition, no password line, no policy path (setup writes each clone's).
  for (const p of policy.partitions) {
    const env = readFileSync(join(dir, "profiles", `.env.${p.name}`), "utf8");
    assert.doesNotMatch(env, /^\s*IBMI_PASSWORD/m, p.name);
    assert.doesNotMatch(env, /IBMI_KIT_POLICY/, p.name);
    assert.match(env, new RegExp(`^IBMI_PARTITION=${p.name}$`, "m"));
  }
  // team-onboarding: .mcp.json registers the kit with no machine path, and every env key reaches the profile.
  const server = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers["ibmi-agent-kit"];
  assert.ok(server, ".mcp.json registers no ibmi-agent-kit");
  const block = readFileSync(join(EXAMPLES, "../templates/company-repo/README.md"), "utf8").split("## Get started")[1].match(/```json\n([\s\S]*?)```/)![1];
  assert.deepEqual(JSON.parse(block), JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")), "the template's .mcp.json block and the fixture differ");
  for (const a of [server.command, ...server.args]) assert.ok(!win32.isAbsolute(a) && !posix.isAbsolute(a), `absolute path in .mcp.json: ${a}`);
  assert.ok(Object.keys(server.env).length > 0);
  const tmp = mkdtempSync(join(tmpdir(), "kit-mcp-"));
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { IBMI_KIT_CONFIG_DIR: tmp, HOME: tmp, USERPROFILE: tmp }, server.env);
    writeFileSync(join(tmp, ".env.x"), "IBMI_HOST=h\n");
    const env = resolveProfileEnv("x");
    for (const [k, v] of Object.entries(server.env)) assert.equal(env[k], v, `${k} is protected: the profile loader ignores it in .mcp.json`);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(tmp, { recursive: true, force: true });
  }
  // The README's Get started names clone, setup, claude, approve and /demo in that order.
  const start = readFileSync(join(dir, "README.md"), "utf8").split("## Get started\n")[1]?.split("\n## ")[0] ?? "";
  const at = ["Clone", "setup", "`claude`", "Approve", "/demo", "policy path lives in each person's profile"].map((w) => start.indexOf(w));
  assert.ok(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])), `README Get started steps out of order or missing: ${at}`);
  const r = await runBin(["policy", "test", join(dir, "policy.yaml"), join(dir, "policy.tests.yaml")]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /warning:/);
});

// config-bootstrap 2.5: the README's permission rules, evaluated deny-first, keep runs/ readable and profiles unreadable.
test("company-repo README: Read rules allow ~/.ibmi-agent-kit/runs and deny the profiles", () => {
  const md = readFileSync(join(EXAMPLES, "../templates/company-repo/README.md"), "utf8");
  const perms = JSON.parse(md.split("## Client permission rules")[1].match(/```json\n([\s\S]*?)```/)![1]).permissions;
  const reads = (l: string[]) => l.filter((r) => r.startsWith("Read(")).map((r) => r.slice(5, -1));
  const allow = reads(perms.allow), deny = reads(perms.deny);
  assert.ok(!perms.deny.includes("Read(~/.ibmi-agent-kit/**)"), "blanket deny would beat the runs allow");
  // shortcut: gitignore-lite (* in one segment, ** any depth, a match covers what is under it); upgrade if rules grow.
  const match = (pat: string, path: string) => {
    const re = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
    return new RegExp(`^${re}(/.*)?$`).test(path);
  };
  const allowed = (p: string) => !deny.some((d) => match(d, p)) && allow.some((a) => match(a, p));
  assert.ok(allowed("~/.ibmi-agent-kit/runs/2026-10-31.jsonl"));
  for (const f of [".env", ".env.prod", "private.txt"]) assert.ok(!allowed(`~/.ibmi-agent-kit/${f}`), f);
  assert.ok(deny.some((d) => match(d, "~/.ibm-i-servers/.env.prod")), "~/.ibm-i-servers profiles denied");
});

// config-bootstrap: every discovery query passes run_sql's select gate and the guard classes it read-only.
test("policy templates: every ibmi-kit-config discovery query passes run_sql and classifies as read", async () => {
  const md = readFileSync(join(EXAMPLES, "../.claude/skills/ibmi-kit-config/references/discovery.md"), "utf8");
  const queries = [...md.matchAll(/```sql\n([\s\S]*?)```/g)].flatMap((m) => m[1].split("\n")).filter((l) => l.trim());
  assert.ok(queries.length >= 20, `found ${queries.length} queries`);
  const { assertSelectOnly } = await import(new URL("../../source/dist/util.js", import.meta.url).href);
  for (const q of queries) {
    assert.doesNotThrow(() => assertSelectOnly(q), q);
    const c = await classify(q, { lookups: statedLookups() });
    assert.ok(c.operations.length > 0 && c.operations.every((o) => o.class === "read"), `${q}: ${JSON.stringify(c.operations.map((o) => o.class))}`);
  }
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
// A box: answers the guard's own queries, records every script statement that reaches it. Like the
// backend, a send checks the job generation after connecting and before sending.
function stubConn(
  o: { rdb?: string; user?: string; userInfo?: Row | null; authlists?: string[]; readOnly?: boolean; blockedTables?: string[]; failOn?: string; resetOn?: string; curlib?: string[]; viewdepThrows?: boolean; hangOn?: string; member?: string[]; identityFails?: number; userInfoFails?: number; authlistFails?: number } = {},
) {
  const sent: string[] = [];
  const queries: string[] = [];
  let curlibAsked = 0;
  let identityFails = o.identityFails ?? 0; // the first N identity / USER_INFO queries throw (Infinity: all)
  let userInfoFails = o.userInfoFails ?? 0;
  let authlistFails = o.authlistFails ?? 0;
  const own = (sql: string): Row[] | undefined => {
    if (sql.startsWith("SELECT CURRENT SERVER") && identityFails-- > 0) throw new Error("connect ECONNREFUSED box:8076");
    if (sql.startsWith("SELECT CURRENT SERVER")) return [{ RDB: o.rdb ?? "DEVRDB", USR: o.user ?? "JDOE" }];
    if (sql.includes("QSYS2.USER_INFO") && userInfoFails-- > 0) throw new Error("SQL0551 not authorized to USER_INFO");
    if (sql.includes("QSYS2.USER_INFO")) return o.userInfo === null ? [] : [o.userInfo ?? { G: "GRPDEV", S: "" }];
    if (sql.includes("AUTHORIZATION_LIST_USER_INFO") && authlistFails-- > 0) throw new Error("SQL0551 not authorized to AUTHORIZATION_LIST_USER_INFO");
    if (sql.includes("AUTHORIZATION_LIST_USER_INFO")) return (o.authlists ?? []).map((a) => ({ A: a }));
    if (sql.includes("QSYS2.SYSVIEWDEP") && o.viewdepThrows) throw new Error("SQL0551 not authorized to SYSVIEWDEP");
    if (sql.includes("QSYS2.LIBRARY_LIST_INFO")) {
      const c = o.curlib?.[Math.min(curlibAsked++, o.curlib.length - 1)];
      return c ? [{ S: c }] : [];
    }
    if (/QSYS2\.(SYSSCHEMAS|SYSTABLES|SYSVIEWDEP)/.test(sql)) return [];
    return undefined;
  };
  const send = (sql: string, generation?: number) => {
    if (o.resetOn && sql.includes(o.resetOn)) conn.generation!++; // the job dropped; connect opened a new one
    if (generation !== undefined && generation !== conn.generation) throw new Error("the connection to the IBM i was reset after this was decided; not sent");
    sent.push(sql);
    if (o.failOn && sql.includes(o.failOn)) throw new Error(`SQL0204 ${o.failOn} not found`);
  };
  const conn: Conn = {
    generation: 0,
    profile: { user: o.user ?? "JDOE", password: "Secret1x", readOnly: o.readOnly ?? false, blockedTables: o.blockedTables ?? [], blockedCl: [] },
    async query(sql, _params, maxRows = 100, _reporter, generation) {
      queries.push(sql);
      const rows = own(sql);
      if (rows) return { rows, columns: [], truncated: false };
      queries.pop();
      send(sql, generation);
      if (o.hangOn && sql.includes(o.hangOn)) await new Promise<never>(() => {}); // a query that never returns
      if (o.member && /from qtemp\.MCPREAD/i.test(sql)) return { rows: o.member.map((l) => ({ SRCDTA: l })), columns: [], truncated: false }; // the source engine reading a member
      const data = [{ A: 1 }, { A: 2 }, { A: 3 }];
      return { rows: data.slice(0, maxRows), columns: [{ name: "A" }], truncated: data.length > maxRows };
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
  return { conn, sent, queries };
}

async function guardedKit(o: { policy?: Policy; stub?: ReturnType<typeof stubConn>; be?: MapepireBackend; screen?: () => Session; system?: string; elicit?: (req: any) => Promise<ElicitResult>; timeoutMs?: number; sqlTimeLimitMs?: number; memberText?: ServerDeps["memberText"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kit-runs-"));
  const notices: string[] = [];
  const stub = o.stub ?? stubConn();
  const be = o.be;
  const kit = createServer({
    policy: o.policy ?? builtinPolicy(),
    conn: () => be ?? stub.conn,
    ...(be ? { sourceBackend: () => be } : {}),
    ...(o.screen ? { screenSession: o.screen } : {}),
    ...(o.memberText ? { memberText: o.memberText } : {}),
    profileEnv: () => ({}),
    ...(o.system !== undefined ? { systemName: () => o.system } : {}), // else the screen engine's sign-on System field
    runLogDir: dir,
    confirmTimeoutMs: o.timeoutMs ?? 5000,
    sqlTimeLimitMs: o.sqlTimeLimitMs ?? 5000,
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
  ["cancel", async () => ({ action: "cancel" })],
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

test("5.2: a connection reset after the script was decided: the statement after it is not sent", async () => {
  const k = await guardedKit({ stub: stubConn({ resetOn: "MYLIB.B" }) });
  try {
    const r = await k.call("run_script", { script: "INSERT INTO MYLIB.A VALUES 1;\nINSERT INTO MYLIB.B VALUES 2;\nINSERT INTO MYLIB.C VALUES 3" });
    assert.equal(r.error, true);
    assert.deepEqual(k.stub.sent, ["INSERT INTO MYLIB.A VALUES 1"]);
    assert.deepEqual(r.s.statements.map((x: any) => x.outcome), ["ok", "failed", "not sent"]);
    assert.match(r.s.statements[1].error, /reset after this was decided/);
  } finally {
    await k.close();
  }
});

test("5.2: a query past the time limit resets the session, and the next statement is not sent", async () => {
  const k = await guardedKit({ stub: stubConn({ hangOn: "MYLIB.HANG" }), sqlTimeLimitMs: 50 });
  try {
    const r = await k.call("run_script", { script: "SELECT * FROM MYLIB.HANG;\nINSERT INTO MYLIB.B VALUES 1" });
    assert.equal(r.error, true);
    assert.equal(k.stub.conn.generation, 1, "the session was reset");
    assert.deepEqual(k.stub.sent, ["SELECT * FROM MYLIB.HANG"]);
    assert.deepEqual(r.s.statements.map((x: any) => x.outcome), ["failed", "not sent"]);
    assert.match(r.s.statements[0].error, /gave up after 0\.05s and reset the session/);
  } finally {
    await k.close();
  }
});

test("5.2: *CURLIB after CHGCURLIB in the script is refused although the box answers JDOE", async () => {
  const k = await guardedKit({ stub: stubConn({ curlib: ["JDOE"] }) });
  try {
    const r = await k.call("run_script", { script: "CL: CHGCURLIB LVORD\nCL: CLRPFM FILE(*CURLIB/ORDERS)" });
    assert.equal(r.error, true);
    assert.match(r.text, /statement 2 .*the script changes the current library; name the library/);
    assert.deepEqual(k.stub.sent, []);
  } finally {
    await k.close();
  }
});

test("5.3: a current library that changes while confirming stops the script", async () => {
  const k = await guardedKit({
    policy: CONFIRM_POLICY,
    stub: stubConn({ curlib: ["JDOE", "OTHER"] }),
    elicit: async () => ({ action: "accept", content: { confirm: true } }),
  });
  try {
    const r = await k.call("run_script", { script: "CL: CLRPFM FILE(*CURLIB/X)" });
    assert.equal(r.error, true);
    assert.match(r.text, /current library changed from JDOE to OTHER while confirming/);
    assert.deepEqual(k.stub.sent, []);
  } finally {
    await k.close();
  }
});

test("5.3: observe mode with a confirm rule and no elicitation runs without asking, logged confirm/not enforced", async () => {
  const observe = parsePolicy("version: 1\nmode: observe\nrules:\n  - { classes: [write], decision: confirm }\n  - { decision: allow }\n", "observe.yaml");
  const k = await guardedKit({ policy: observe });
  try {
    const r = await k.call("run_script", { script: "DELETE FROM MYLIB.A WHERE K = 1" });
    assert.equal(r.error, false, r.text);
    assert.deepEqual(k.stub.sent, ["DELETE FROM MYLIB.A WHERE K = 1"]);
    const [line] = k.log();
    assert.deepEqual([line.decision, line.enforced, line.effective, line.confirmed], ["confirm", false, "allow", undefined]);
  } finally {
    await k.close();
  }
});

test("5.1: supplemental groups as ten-character slots, full or padded, and blank-separated", async () => {
  assert.deepEqual(supplementalGroups("GRPDEV0001GRPQA00001"), ["GRPDEV0001", "GRPQA00001"]);
  assert.deepEqual(supplementalGroups("GRPDEV0001GRPQA     "), ["GRPDEV0001", "GRPQA"]);
  assert.deepEqual(supplementalGroups("GRPDEV0001GRPQA"), ["GRPDEV0001", "GRPQA"], "the last slot trimmed");
  assert.deepEqual(supplementalGroups("GRPDEV GRPQA"), ["GRPDEV", "GRPQA"]);
  assert.deepEqual(supplementalGroups(""), []);
  const k = await guardedKit({ policy: D4, stub: stubConn({ userInfo: { G: "*NONE", S: "GRPDEV0001GRPQA     " } }) });
  try {
    const { s } = await k.call("policy_check", { script: "SELECT * FROM LVORD.T" });
    assert.deepEqual(s.roles, ["qa"]);
  } finally {
    await k.close();
  }
});

test("5.2: a failed alias/view lookup denies the write through QTEMP.A, even observing", async () => {
  const k = await guardedKit({ stub: stubConn({ viewdepThrows: true }) });
  try {
    const r = await k.call("run_script", { script: "INSERT INTO QTEMP.A VALUES 1" });
    assert.equal(r.error, true);
    assert.match(r.text, /could not resolve alias\/view bases of QTEMP\.A: QSYS2\.SYSVIEWDEP: SQL0551/);
    assert.deepEqual(k.stub.sent, []);
  } finally {
    await k.close();
  }
});

test("5.2: a statement-level deny (partition conflict on COMMIT) still names its reason; runaway catalog views are refused", async () => {
  const k = await guardedKit({ policy: D4, stub: stubConn({ rdb: "QARDB" }), system: "DEVBOX" });
  try {
    const r = await k.call("run_script", { script: "COMMIT" });
    assert.equal(r.error, true);
    assert.match(r.text, /statement 1 \(COMMIT\): denied: System DEVBOX, RDB QARDB map to different partitions/);
  } finally {
    await k.close();
  }
  const b = await guardedKit();
  try {
    const r = await b.call("run_script", { script: "SELECT * FROM QSYS2.SYSPARTITIONINDEXSTAT" });
    assert.match(r.text, /refusing syspartitionindexstat/);
    assert.deepEqual(b.stub.sent, []);
  } finally {
    await b.close();
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

// --- source engine hooks (guarded-tools spec; task 6.1) ---

// The source engine over the stub box: its tools' sends land in stub.sent, the guard's own
// identity and catalog lookups in stub.queries.
async function sourceKit(o: { policy?: Policy; member?: string[]; curlib?: string[]; elicit?: (req: any) => Promise<ElicitResult>; memberText?: ServerDeps["memberText"] } = {}) {
  const stub = stubConn({ member: o.member, curlib: o.curlib });
  const localDir = mkdtempSync(join(tmpdir(), "kit-src-"));
  const transport = {
    connect: async () => {},
    close: async () => {},
    query: (sql: string, params?: unknown[], maxRows?: number) => stub.conn.query(sql, params, maxRows),
    execute: (sql: string, params?: unknown[]) => stub.conn.execute(sql, params),
    cl: (command: string) => stub.conn.cl(command),
  };
  const profile = { host: "box", user: "JDOE", password: "Secret1x", sshPort: 22, sqlTransport: "ssh" as const, mapepirePort: 8076, sourceFileCcsid: 37, localDir, readOnly: false, blockedCl: [], blockedTables: [] };
  const be = new MapepireBackend(profile, transport as unknown as ConstructorParameters<typeof MapepireBackend>[1]);
  const k = await guardedKit({ policy: o.policy ?? D4_ENFORCE, stub, be, ...(o.elicit ? { elicit: o.elicit } : {}), ...(o.memberText ? { memberText: o.memberText } : {}) });
  return { ...k, localDir, close: async () => (await k.close(), rmSync(localDir, { recursive: true, force: true })) };
}

const ORDVAL = { library: "JDOE", sourceFile: "QRPGLESRC", member: "ORDVAL", type: "RPGLE" };

test("6.1: compile_member with an override target is decided as compile into LIVLIB, and the denied call never reaches the box", async () => {
  const k = await sourceKit();
  try {
    const r = await k.call("compile_member", { ...ORDVAL, targetLibrary: "JDOE", command: "CRTBNDRPG PGM(LIVLIB/ORDVAL) SRCFILE(JDOE/QRPGLESRC) SRCMBR(ORDVAL)" });
    assert.equal(r.error, true);
    assert.match(r.text, /no rule matches compile LIVLIB\.ORDVAL \(environment unmatched, partition dev\): denied/);
    assert.match(r.text, /Ask the user how to proceed/);
    assert.match(r.text, /IBM i authority remains the real boundary/);
    assert.deepEqual(k.stub.sent, [], "nothing but the guard's lookups reaches the box");
    const [line] = k.log();
    assert.deepEqual([line.tool, line.kind, line.decision, line.operations[0].class, line.operations[0].object], ["compile_member", "cl", "deny", "compile", { lib: "LIVLIB", name: "ORDVAL" }]);
    // The same call without the override compiles into JDOE.
    const ok = await k.call("compile_member", { ...ORDVAL, targetLibrary: "JDOE" });
    assert.equal(ok.error, false, ok.text);
    const sent: string[] = k.stub.sent; // assert.deepEqual above narrowed it to []
    assert.ok(sent.some((s) => s.startsWith("crtbndrpg pgm(JDOE/ORDVAL) srcfile(JDOE/QRPGLESRC)")), sent.join("\n"));
    assert.equal(k.log()[1].outcome, "ok");
  } finally {
    await k.close();
  }
});

test("6.1: every built-in compile template is in the command table, so the policy can allow it", async () => {
  const k = await sourceKit();
  try {
    for (const type of ["RPGLE", "SQLRPGLE", "CLLE", "CLP", "CBL", "CBLLE", "SQLCBLLE", "DSPF", "PRTF", "PF", "LF", "CMD", "SQL"]) {
      const r = await k.call("compile_member", { ...ORDVAL, type, targetLibrary: "JDOE" });
      assert.equal(r.error, false, `${type}: ${r.text}`);
    }
  } finally {
    await k.close();
  }
});

test("6.1: an allowed call the engine itself refuses is logged with its failure", async () => {
  const k = await sourceKit();
  try {
    const r = await k.call("run_sql", { statement: "delete from JDOE.T" }); // the policy allows dev writes to JDOE
    assert.equal(r.error, true);
    assert.deepEqual(k.stub.sent, []);
    const [line] = k.log();
    assert.deepEqual([line.decision, line.effective], ["allow", "allow"]);
    assert.match(line.outcome, /^failed: .*select/i);
  } finally {
    await k.close();
  }
});

test("6.1: a denied run_sql, read_source_member, search_source, upload_source_member and manage_library_list never reach the box", async () => {
  const k = await sourceKit();
  try {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["run_sql", { statement: "select * from PAYLIB.T" }, /rule 2 denies read PAYLIB\.T/],
      ["read_source_member", { library: "paylib", sourceFile: "QRPGLESRC", member: "PAY1" }, /rule 2 denies read PAYLIB\.QRPGLESRC/],
      ["search_source", { library: "PAYLIB", searchTerm: "x" }, /rule 2 denies read library PAYLIB/],
      ["upload_source_member", { library: "LVORD", sourceFile: "QRPGLESRC", member: "X", content: "x" }, /no rule matches write LVORD\.QRPGLESRC/],
      ["manage_library_list", { action: "add", library: "PAYLIB" }, /rule 2 denies liblist library PAYLIB/],
    ];
    for (const [tool, args, why] of cases) {
      const r = await k.call(tool, args);
      assert.equal(r.error, true, tool);
      assert.match(r.text, why, tool);
      assert.deepEqual(k.stub.sent, [], `${tool} reached the box`);
    }
    assert.deepEqual(readdirSync(k.localDir), [], "nothing was downloaded");
    const read = k.log().find((l) => l.tool === "read_source_member");
    assert.deepEqual([read.kind, read.text, read.raw], ["tool", "read_source_member PAYLIB/QRPGLESRC(PAY1)", [{ class: "read", object: { lib: "PAYLIB", name: "QRPGLESRC" }, source: "sql" }]]);
    // An allowed one is logged and reaches the box; show is never decided.
    const ok = await k.call("read_source_member", { library: "JDOE", sourceFile: "QRPGLESRC", member: "ORDVAL" });
    assert.equal(ok.error, false, ok.text);
    assert.ok(k.stub.sent.length > 0);
    const lines = k.log().length;
    await k.call("manage_library_list", { action: "show" });
    assert.equal(k.log().length, lines);
  } finally {
    await k.close();
  }
});

test("6.1: an SQL member compiled with RUNSQLSTM is decided by its statements, read at decision time", async () => {
  const bad = await sourceKit({ member: ["INSERT INTO JDOE.T VALUES 1;", "DELETE FROM PAYLIB.T;"] });
  try {
    const r = await bad.call("compile_member", { library: "JDOE", sourceFile: "QSQLSRC", member: "SETUP", type: "SQL" });
    assert.equal(r.error, true);
    assert.match(r.text, /rule 2 denies write PAYLIB\.T/);
    assert.ok(!bad.stub.sent.some((s) => /runsqlstm/i.test(s)), bad.stub.sent.join("\n"));
    const lines = bad.log();
    assert.deepEqual(lines.map((l) => l.kind), ["tool", "sql", "sql"]);
    assert.deepEqual(lines[0].raw.map((o: any) => [o.class, o.object]), [["read", { lib: "JDOE", name: "QSQLSRC" }]]);
    // A RUNSQLSTM whose statements cannot be read is danger.
    const stmf = await bad.call("compile_member", { ...ORDVAL, command: "RUNSQLSTM SRCSTMF('/tmp/x.sql')" });
    assert.match(stmf.text, /RUNSQLSTM must name SRCFILE\(LIB\/FILE\) and SRCMBR/);
  } finally {
    await bad.close();
  }
  const good = await sourceKit({ member: ["INSERT INTO JDOE.T VALUES 1;"] });
  try {
    const r = await good.call("compile_member", { library: "JDOE", sourceFile: "QSQLSRC", member: "SETUP", type: "SQL" });
    assert.equal(r.error, false, r.text);
    assert.ok(good.stub.sent.some((s) => s.startsWith("runsqlstm srcfile(JDOE/QSQLSRC) srcmbr(SETUP)")), good.stub.sent.join("\n"));
  } finally {
    await good.close();
  }
});

test("6.1: an SQL member in a library the policy denies reading is never fetched, and its text is in no message", async () => {
  const k = await sourceKit({ member: ["DELETE FROM PAYLIB.SALARY;"] });
  try {
    const r = await k.call("compile_member", { library: "PAYLIB", sourceFile: "QSQLSRC", member: "SETUP", type: "SQL", targetLibrary: "JDOE" });
    assert.equal(r.error, true);
    assert.match(r.text, /rule 2 denies read PAYLIB\.QSQLSRC/);
    assert.doesNotMatch(r.text, /SALARY/);
    assert.deepEqual(k.stub.sent, [], "the member was not read");
    assert.doesNotMatch(JSON.stringify(k.log()), /SALARY/);
    // With a command that reads no SRCFILE itself, the member's read is decided on its own line.
    const own = await k.call("compile_member", { library: "PAYLIB", sourceFile: "QSQLSRC", member: "SETUP", type: "SQL", command: "CRTSQLRPGI OBJ(JDOE/SETUP) SRCFILE(JDOE/QSQLSRC) SRCMBR(SETUP)" });
    assert.equal(own.error, true);
    assert.doesNotMatch(own.text, /SALARY/);
    assert.deepEqual(k.stub.sent, []);
    const read = k.log().at(-1);
    assert.deepEqual([read.kind, read.text, read.effective], ["tool", "read PAYLIB/QSQLSRC(SETUP)", "deny"]);
  } finally {
    await k.close();
  }
});

// --- an SQL member whose read a rule asks to confirm (task 6.4) ---

const READ_CONFIRM = parsePolicy("version: 1\nmode: enforce\nrules:\n  - { classes: [danger], decision: deny }\n  - { classes: [read], decision: confirm }\n  - { decision: allow }\n", "read-confirm.yaml");
const SQL_MEMBER = { library: "JDOE", sourceFile: "QSQLSRC", member: "SETUP", type: "SQL", targetLibrary: "JDOE" };
const MEMBER_SQL = "INSERT INTO JDOE.T VALUES 'ZQX9TOK';"; // ZQX9TOK: the member's text, to find wherever it leaks
// The run log line holding the member's read: RUNSQLSTM's own command line, or the read line.
const readLine = (l: any) => l.operations.some((o: any) => o.class === "read" && o.object?.name === "QSQLSRC");
const COMPILES: [string, Record<string, unknown>][] = [
  ["RUNSQLSTM", SQL_MEMBER],
  ["type SQL with its own command", { ...SQL_MEMBER, command: "CRTSQLRPGI OBJ(JDOE/SETUP) SRCFILE(JDOE/QSQLSRC) SRCMBR(SETUP)" }],
];
for (const [name, args] of COMPILES) {
  test(`6.4: ${name}: a confirmed member read is asked before the member is fetched, with none of its lines`, async () => {
    const calls: string[] = [];
    const prompts: string[] = [];
    let text = MEMBER_SQL;
    const k = await sourceKit({
      policy: READ_CONFIRM,
      memberText: async () => (calls.push("memberText"), text),
      elicit: async (req) => (calls.push("elicit"), prompts.push(req.params.message), { action: "accept", content: { confirm: true } }),
    });
    try {
      const r = await k.call("compile_member", args);
      assert.equal(r.error, false, r.text);
      assert.deepEqual(calls, ["elicit", "memberText"], "asked once, then fetched: the command's read is not asked again");
      assert.match(prompts[0], /read JDOE\.QSQLSRC/);
      assert.doesNotMatch(prompts[0], /ZQX9TOK|INSERT/);
      assert.ok(k.stub.sent.length > 0);
      assert.deepEqual(k.log().filter(readLine).map((l) => l.confirmed), name === "RUNSQLSTM" ? [true] : [true, true]);
      // A member statement that itself needs confirming is asked in a second prompt, which may show it.
      calls.length = 0;
      text = "INSERT INTO JDOE.T SELECT * FROM JDOE.U WHERE C = 'ZQX9TOK';";
      const again = await k.call("compile_member", args);
      assert.equal(again.error, false, again.text);
      assert.deepEqual(calls, ["elicit", "memberText", "elicit"]);
      assert.match(prompts.at(-1)!, /read JDOE\.U[\s\S]*ZQX9TOK/);
    } finally {
      await k.close();
    }
  });

  test(`6.4: ${name}: a declined member read, or a client without elicitation, fetches nothing and logs none of it`, async () => {
    const prompts: string[] = [];
    for (const elicit of [async (req: any): Promise<ElicitResult> => (prompts.push(req.params.message), { action: "decline" }), undefined]) {
      const calls: string[] = [];
      const k = await sourceKit({ policy: READ_CONFIRM, memberText: async () => (calls.push("memberText"), MEMBER_SQL), ...(elicit ? { elicit } : {}) });
      try {
        const r = await k.call("compile_member", args);
        assert.equal(r.error, true);
        assert.match(r.text, elicit ? /the user chose decline/ : /confirmation is unavailable in this client/);
        assert.deepEqual(calls, [], "the member was not fetched");
        assert.deepEqual(k.stub.sent, []);
        const log = k.log();
        assert.doesNotMatch(JSON.stringify(log) + r.text + prompts.join("\n"), /ZQX9TOK/);
        assert.ok(log.filter(readLine).length > 0);
        for (const l of log.filter(readLine)) assert.deepEqual([l.confirmed, /^not sent: /.test(l.outcome)], [false, true]);
      } finally {
        await k.close();
      }
    }
    assert.equal(prompts.length, 1);
  });
}

test("6.4: a member that cannot be fetched after a confirmed read is logged not sent", async () => {
  const k = await sourceKit({ policy: READ_CONFIRM, memberText: async () => Promise.reject(new Error("CPF9815 member not found")), elicit: async () => ({ action: "accept", content: { confirm: true } }) });
  try {
    const r = await k.call("compile_member", SQL_MEMBER);
    assert.equal(r.error, true);
    assert.match(r.text, /cannot read JDOE\/QSQLSRC\(SETUP\) to decide its statements: CPF9815/);
    assert.deepEqual(k.stub.sent, []);
    const [line] = k.log();
    assert.equal(line.confirmed, true);
    assert.match(line.outcome, /^not sent: refused: cannot read JDOE\/QSQLSRC\(SETUP\)/);
  } finally {
    await k.close();
  }
});

test("6.4: a *CURLIB that moved while the member read was confirmed stops the compile", async () => {
  // The member's own *CURLIB is decided with the answer recorded before the wait, so the recheck still sees the move.
  const member = `${MEMBER_SQL}\nCL: CRTDTAARA DTAARA(*CURLIB/X) TYPE(*CHAR)`;
  const k = await sourceKit({ policy: READ_CONFIRM, curlib: ["JDOE", "OTHER"], memberText: async () => member, elicit: async () => ({ action: "accept", content: { confirm: true } }) });
  try {
    const r = await k.call("compile_member", { ...SQL_MEMBER, command: "CRTSQLRPGI OBJ(*CURLIB/SETUP) SRCFILE(JDOE/QSQLSRC) SRCMBR(SETUP)" });
    assert.equal(r.error, true);
    assert.match(r.text, /current library changed from JDOE to OTHER while confirming/);
    assert.deepEqual(k.stub.sent, []);
  } finally {
    await k.close();
  }
});

test("6.1: a source tool whose write a rule asks to confirm sends nothing when declined", async () => {
  const k = await sourceKit({ policy: CONFIRM_POLICY, elicit: async () => ({ action: "decline" }) });
  try {
    const r = await k.call("upload_source_member", { library: "JDOE", sourceFile: "QRPGLESRC", member: "ORDVAL", content: "x" });
    assert.equal(r.error, true);
    assert.match(r.text, /the user chose decline/);
    assert.deepEqual(k.stub.sent, []);
    assert.deepEqual([k.log()[0].confirmed, k.log()[0].outcome], [false, "not sent: the user chose decline"]);
  } finally {
    await k.close();
  }
  // Accepted with confirm: true it runs, logged confirmed; a *CURLIB that moved while confirming stops it.
  const policy = parsePolicy("version: 1\nmode: enforce\nrules:\n  - { classes: [danger], decision: deny }\n  - { classes: [write, compile], decision: confirm }\n  - { decision: allow }\n", "confirm.yaml");
  const ok = await sourceKit({ policy, curlib: ["JDOE", "OTHER"], elicit: async () => ({ action: "accept", content: { confirm: true } }) });
  try {
    const r = await ok.call("upload_source_member", { library: "JDOE", sourceFile: "QRPGLESRC", member: "ORDVAL", content: "x", create: true, memberType: "RPGLE" });
    assert.equal(r.error, false, r.text);
    assert.ok(ok.stub.sent.length > 0);
    assert.deepEqual([ok.log()[0].confirmed, ok.log()[0].outcome], [true, "ok"]);
    const sent = ok.stub.sent.length;
    const moved = await ok.call("compile_member", ORDVAL); // into *CURLIB, JDOE when decided
    assert.equal(moved.error, true);
    assert.match(moved.text, /current library changed from JDOE to OTHER while confirming/);
    assert.equal(ok.stub.sent.length, sent);
    assert.deepEqual([ok.log()[1].confirmed, ok.log()[1].outcome], [true, "not sent: the current library changed from JDOE to OTHER while confirming"]);
  } finally {
    await ok.close();
  }
});

// --- screen engine hooks (guarded-tools spec; task 6.2) ---

// The D4 example, enforced, with the screen engine's captured sign on record (System MYBOX1) listed
// as partition `as`'s System name.
const d4With = (as: "DEVBOX" | "QABOX") => parsePolicy(readFileSync(D4_PATH, "utf8").replace("mode: { default: observe, prod: enforce }", "mode: enforce").replace(`[${as}]`, "[MYBOX1]"), D4_PATH);

// A 5250 session over a fake host: open() paints that sign on record, the sign on lands on a
// command entry screen. `sent` holds every record that would have reached the box.
function fakeScreen() {
  const rec = readFileSync(fileURLToPath(new URL("../../screen/test/fixtures/signon.bin", import.meta.url)));
  const profile: ConstructorParameters<typeof Session>[0] = {
    host: "h", user: "JDOE", password: "Secret1x", port: 23, tls: false, tlsInsecure: false, terminalType: "IBM-3179-2", ccsid: 37, rows: 24, cols: 80,
    restricted: false, allowedCl: [], blockedCl: [], viewerEnabled: false, viewerPort: 5250,
  };
  const s = new Session(profile);
  const sent: Buffer[] = [];
  const commandLine = { id: "f1", row: 20, col: 7, length: 153, attr: 0x20, protectedField: false, shift: "alpha shift", monocase: false, mandatory: false, autoEnter: false, mdt: false, seq: Number.MAX_SAFE_INTEGER };
  Object.assign(s, {
    conn: { sendRecord: (r: Buffer) => void (sent.push(r), s.looksLikeSignOn() && (s.screen.fields = [{ ...commandLine }] as typeof s.screen.fields)), close() {} },
    settle: async () => void (s.screen.keyboardLocked = false),
  });
  s.open = async () => void s.screen.apply(rec);
  return { s, sent };
}

test("6.2: session_open's program is decided as a call in the partition the sign-on System field names; a deny signs nothing on", async () => {
  const host = fakeScreen();
  const k = await guardedKit({ policy: d4With("DEVBOX"), screen: () => host.s });
  try {
    const r = await k.call("session_open", { program: "livlib/ordfix" });
    assert.equal(r.error, true);
    assert.match(r.text, /Denied, session_open did nothing:\n  session_open program LIVLIB\/ORDFIX: no rule matches call LIVLIB\.ORDFIX \(environment unmatched, partition dev\)/);
    assert.match(r.text, /Ask the user how to proceed/);
    assert.deepEqual(host.sent, [], "no sign on reached the box");
    const [line] = k.log();
    assert.deepEqual([line.tool, line.kind, line.text, line.names, line.raw[0].class, line.raw[0].object], ["session_open", "tool", "session_open program LIVLIB/ORDFIX", { system: "MYBOX1", rdb: "DEVRDB" }, "call", { lib: "LIVLIB", name: "ORDFIX" }]);
  } finally {
    await k.close();
  }
  // A System name that maps to another partition than the RDB denies, as in 5.1.
  const qa = fakeScreen();
  const c = await guardedKit({ policy: d4With("QABOX"), screen: () => qa.s });
  try {
    const r = await c.call("session_open", { library: "JDOE" });
    assert.equal(r.error, true);
    assert.match(r.text, /System MYBOX1, RDB DEVRDB map to different partitions: dev and qa/);
    assert.deepEqual(qa.sent, []);
  } finally {
    await c.close();
  }
});

test("6.2: a 5250 command line is decided as CL when the key is pressed; a denied one is never sent", async () => {
  const host = fakeScreen();
  const k = await guardedKit({ policy: d4With("DEVBOX"), screen: () => host.s });
  try {
    assert.equal((await k.call("session_open", {})).error, false, "nothing to decide");
    assert.equal(host.sent.length, 1);
    const r = await k.call("screen_do", { actions: ["type f1: dltlib lvord", "key: Enter"] });
    assert.equal(r.error, true);
    assert.match(r.text, /"key: Enter" failed: Denied, screen_command did nothing:\n  dltlib lvord: no rule matches ddl library LVORD \(environment live, partition dev\)/);
    assert.equal(host.sent.length, 1, "Enter never went out");
    const ok = await k.call("screen_do", { actions: ["type f1: DSPLIBL", "key: Enter"] });
    assert.equal(ok.error, false, ok.text);
    assert.equal(host.sent.length, 2);
    // F4 prompts: the values come later on a screen with no command line, so it is denied as `?`.
    const f4 = await k.call("screen_do", { actions: ["type f1: ADDLIBLE", "key: F4"] }); // ADDLIBLE alone is allowed (rule 9)
    assert.equal(f4.error, true);
    assert.match(f4.text, /\?ADDLIBLE: prompting \(\?\) lets values be typed later/);
    assert.equal(host.sent.length, 2);
    assert.deepEqual(k.log().map((l) => [l.tool, l.kind, l.text, l.effective, l.outcome.split(":")[0]]), [
      ["screen_command", "cl", "dltlib lvord", "deny", "denied"], // replay adds the CL: itself
      ["screen_command", "cl", "DSPLIBL", "allow", "ok"],
      ["screen_command", "cl", "?ADDLIBLE", "deny", "denied"],
    ]);
    // The engine's own sign off is not decided.
    await k.call("session_close", {});
    assert.equal(host.sent.length, 3);
    assert.equal(k.log().length, 3);
  } finally {
    await k.close();
  }
});

test("6.2: a 5250 command line is decided against the 5250 job: *CURLIB is unqualified and QTEMP's aliases are unseen", async () => {
  const host = fakeScreen();
  const k = await guardedKit({ policy: d4With("DEVBOX"), stub: stubConn({ curlib: ["JDOE"] }), screen: () => host.s });
  try {
    assert.equal((await k.call("session_open", {})).error, false);
    assert.equal((await k.call("screen_do", { actions: ["type f1: CHGCURLIB LVORD", "key: Enter"] })).error, false);
    // The SQL job's current library is JDOE, where dev may write; the 5250 job's is now LVORD.
    const clr = await k.call("screen_do", { actions: ["type f1: CLRPFM FILE(*CURLIB/ORDERS)", "key: Enter"] });
    assert.equal(clr.error, true);
    assert.match(clr.text, /Denied, screen_command did nothing:\n  CLRPFM FILE\(\*CURLIB\/ORDERS\): /);
    assert.equal(host.sent.length, 2, "CLRPFM never went out");
    assert.ok(!k.stub.queries.some((q) => q.includes("LIBRARY_LIST_INFO")), "the SQL job's current library is not asked");
    // An alias made in the 5250 job's QTEMP cannot be seen through, so a write through it is danger.
    assert.equal((await k.call("screen_do", { actions: ["type f1: RUNSQL SQL('CREATE ALIAS QTEMP.A FOR LVORD.ORDERS')", "key: Enter"] })).error, false);
    const del = await k.call("screen_do", { actions: ["type f1: RUNSQL SQL('DELETE FROM QTEMP.A')", "key: Enter"] });
    assert.equal(del.error, true);
    assert.match(del.text, /the 5250 job's QTEMP is not visible to the guard/);
    assert.equal(host.sent.length, 3, "the DELETE never went out");
    // The run log keeps those answers, so replay decides the same.
    assert.equal(k.log().at(-1).lookups.bases["QTEMP.A"], null);
    assert.deepEqual((await replayRunLog(d4With("DEVBOX"), k.log())).changes, []);
  } finally {
    await k.close();
  }
});

test("6.3: a failed identity lookup decides as the profile's user with default_role, logged, and is asked again on the next key", async () => {
  const host = fakeScreen();
  const k = await guardedKit({ policy: d4With("DEVBOX"), stub: stubConn({ identityFails: Infinity }), screen: () => host.s });
  try {
    assert.equal((await k.call("session_open", {})).error, false);
    const ok = await k.call("screen_do", { actions: ["type f1: DSPLIBL", "key: Enter"] });
    assert.equal(ok.error, false, ok.text);
    const denied = await k.call("screen_do", { actions: ["type f1: dltlib lvord", "key: Enter"] });
    assert.equal(denied.error, true);
    assert.equal(host.sent.length, 2, "only DSPLIBL went out");
    const lines = k.log();
    assert.deepEqual(lines.map((l) => [l.roles, l.roleSource, l.effective]), [
      [["analyst"], "default_lookup_failed", "allow"],
      [["analyst"], "default_lookup_failed", "deny"],
    ]);
    assert.match(lines[0].notes.join("\n"), /identity lookup failed, so JDOE from the profile decides with default_role: connect ECONNREFUSED/);
    assert.equal(k.stub.queries.filter((q) => q.startsWith("SELECT CURRENT SERVER")).length, 2, "one lookup per guarded call: the fallback is not kept");
  } finally {
    await k.close();
  }
});

// Three run_script calls where the first lookup throws: the first decides with default_role, the
// second asks again and holds the role it grants, the third uses the cached success.
async function retriedLookup(stub: ReturnType<typeof stubConn>, failed: RegExp, asked: string, role = "dev") {
  const k = await guardedKit({ policy: D4, stub });
  try {
    for (const t of ["T", "U", "V"]) await k.call("run_script", { script: `SELECT * FROM LVORD.${t}` });
    const lines = k.log();
    assert.deepEqual(lines.map((l) => l.roles), [["analyst"], [role], [role]]);
    assert.equal(lines[0].roleSource, "default_lookup_failed");
    assert.match(lines[0].notes.join("\n"), failed);
    assert.ok(!lines.slice(1).some((l) => l.notes?.length), "no failure note once the lookup works");
    assert.equal(k.stub.queries.filter((q) => q.includes(asked)).length, 2, "asked again after the failure, then cached");
  } finally {
    await k.close();
  }
}

test("6.3: an identity lookup that fails once is asked again on the next call, which holds the group role", () =>
  retriedLookup(stubConn({ identityFails: 1 }), /identity lookup failed, so JDOE from the profile decides with default_role/, "SELECT CURRENT SERVER"));

test("6.3: a group lookup that throws once is not cached: the next call reads the groups", () =>
  retriedLookup(stubConn({ userInfoFails: 1 }), /group lookup for JDOE failed: SQL0551/, "QSYS2.USER_INFO"));

test("6.3: an authorization-list lookup that throws once is not cached: the next call holds the list's role", () =>
  retriedLookup(stubConn({ userInfo: { G: "*NONE", S: "" }, authlists: ["AUTLQA"], authlistFails: 1 }), /authorization list lookup for JDOE failed: SQL0551/, "AUTHORIZATION_LIST_USER_INFO", "qa"));
