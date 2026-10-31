import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
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
  const kit = createServer();
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
    for (const n of ["run_sql", "list_servers"]) assert.equal(ann(n)?.readOnlyHint, true, n);
    for (const n of ["compile_member", "upload_source_member", "screen_do"]) {
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
