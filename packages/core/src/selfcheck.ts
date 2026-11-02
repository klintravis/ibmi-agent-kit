import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_DIRS, listServers, resolveProfileEnv, credentialAccount, deleteStoredSecret, fetchSecret, lastSecret,
  parseHelperCommand, passwordSource, resetSignOnState, runHelper, setCredentialStore, signOnOnce, splitCommand,
  storeSecret, type CredentialStore, type SignOnProfile,
} from "./index.js";

// Each test gets an empty fake home; process.env is saved and restored around it.
let saved: NodeJS.ProcessEnv;
let root: string;
let home: string;
beforeEach(() => {
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("IBMI_")) delete process.env[k];
  root = mkdtempSync(join(tmpdir(), "kit-core-"));
  home = join(root, "home");
  mkdirSync(home);
  process.env.HOME = home; // os.homedir() reads HOME on POSIX
  process.env.USERPROFILE = home; // and USERPROFILE on Windows
  // Process-wide credential state is reset, and the real OS store is replaced by one that fails the test.
  resetSignOnState();
  setCredentialStore({
    get: async () => assert.fail("a selfcheck reached the real credential store"),
    set: async () => assert.fail("a selfcheck reached the real credential store"),
    delete: async () => assert.fail("a selfcheck reached the real credential store"),
  });
});
afterEach(() => {
  setCredentialStore();
  resetSignOnState();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

const put = (dir: string, file: string, body: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
};
const kit = () => join(home, ".ibmi-agent-kit");
const shared = () => join(home, ".ibm-i-servers");

test("Shared folder fallback", () => {
  put(shared(), ".env.pub400", "IBMI_HOST=a\n");
  assert.deepEqual(listServers(), ["pub400"]);
  assert.equal(resolveProfileEnv("pub400").IBMI_HOST, "a");
});

test("Earlier folder wins", () => {
  put(kit(), ".env.pub400", "IBMI_HOST=kit\n");
  put(shared(), ".env.pub400", "IBMI_HOST=shared\n");
  assert.equal(resolveProfileEnv("pub400").IBMI_HOST, "kit");
});

test("IBMI_KIT_CONFIG_DIR, then IBMI_MCP_CONFIG_DIR, come first", () => {
  const a = join(root, "a");
  const b = join(root, "b");
  put(a, ".env.x", "IBMI_HOST=a\n");
  put(b, ".env.x", "IBMI_HOST=b\n");
  put(kit(), ".env.x", "IBMI_HOST=kit\n");
  process.env.IBMI_MCP_CONFIG_DIR = b;
  assert.equal(resolveProfileEnv("x").IBMI_HOST, "b");
  process.env.IBMI_KIT_CONFIG_DIR = a;
  assert.equal(resolveProfileEnv("x").IBMI_HOST, "a");
  assert.equal(CONFIG_DIRS().length, 3);
});

test(".env.example is never a server", () => {
  put(kit(), ".env.example", "IBMI_HOST=a\n");
  assert.deepEqual(listServers(), []);
  assert.throws(() => resolveProfileEnv("example"), /Available: none/);
});

test("Old per-engine folder ignored", () => {
  put(join(home, ".ibm-i-5250-mcp"), ".env.old", "IBMI_HOST=a\n");
  assert.deepEqual(listServers(), []);
});

test("Path traversal refused", () => {
  put(kit(), ".env.prod", "IBMI_HOST=secret\n");
  put(root, ".env.prod", "IBMI_HOST=outside\n");
  assert.throws(() => resolveProfileEnv("x/../.env.prod"), /Available: prod/);
  assert.throws(() => resolveProfileEnv("../.env.prod"), /Available: prod/);
});

test("Case mismatch refused", () => {
  put(kit(), ".env.prod", "IBMI_HOST=a\n");
  assert.throws(() => resolveProfileEnv("PROD"), /Available: prod/);
});

test("Omitted server", () => {
  put(kit(), ".env", "IBMI_HOST=d\n");
  assert.equal(resolveProfileEnv().IBMI_HOST, "d");
  rmSync(join(kit(), ".env"));
  put(kit(), ".env.prod", "IBMI_HOST=a\n");
  assert.throws(() => resolveProfileEnv(), /Available: prod/);
});

test("No password inheritance", () => {
  put(kit(), ".env.dev", "IBMI_HOST=h\nIBMI_USER=u\n");
  put(kit(), ".env.other", "IBMI_PASSWORD=pw\n");
  process.env.IBMI_PASSWORD = "from-env";
  const env = resolveProfileEnv("dev");
  assert.equal(env.IBMI_PASSWORD, undefined);
  assert.equal(env.IBMI_USER, "u");
});

test("Default file does not leak", () => {
  put(kit(), ".env", "IBMI_RESTRICTED=false\n");
  put(kit(), ".env.prod", "IBMI_HOST=h\n");
  assert.equal(resolveProfileEnv("prod").IBMI_RESTRICTED, undefined);
});

test("Environment cannot lift a guard", () => {
  put(kit(), ".env.dev", "IBMI_HOST=h\n");
  for (const k of [
    "IBMI_RESTRICTED", "IBMI_READ_ONLY", "IBMI_ALLOWED_CL", "IBMI_BLOCKED_CL", "IBMI_BLOCKED_TABLES",
    "IBMI_SQL_TRANSPORT", "IBMI_5250_TLS_INSECURE", "IBMI_USER", "IBMI_PASSWORD", "IBMI_SSH_PORT",
    "IBMI_MAPEPIRE_PORT", "IBMI_PARTITION", "IBMI_KIT_POLICY", "IBMI_KIT_VERBS",
  ]) process.env[k] = "false";
  process.env.IBMI_HOST = "evil";
  const env = resolveProfileEnv("dev");
  assert.equal(env.IBMI_HOST, "h");
  assert.deepEqual(Object.keys(env), ["IBMI_HOST", "IBMI_KIT_PROFILE_FILE"]);
});

test("The file wins over the environment", () => {
  put(kit(), ".env.dev", "IBMI_5250_VIEWER=false\n");
  process.env.IBMI_5250_VIEWER = "true";
  assert.equal(resolveProfileEnv("dev").IBMI_5250_VIEWER, "false");
});

test("Viewer setting from the registration", () => {
  put(kit(), ".env.dev", "IBMI_HOST=h\n");
  process.env.IBMI_5250_VIEWER = "true";
  assert.equal(resolveProfileEnv("dev").IBMI_5250_VIEWER, "true");
});

test("Same file for both", () => {
  put(kit(), ".env.pub400", "IBMI_HOST=a\n");
  assert.deepEqual(resolveProfileEnv("pub400"), resolveProfileEnv("pub400"));
});

test("process.env is unchanged after loading", () => {
  put(kit(), ".env", "IBMI_HOST=d\nIBMI_NEW=1\n");
  put(kit(), ".env.dev", "IBMI_HOST=h\nIBMI_NEW=2\n");
  const before = { ...process.env };
  resolveProfileEnv();
  resolveProfileEnv("dev");
  listServers();
  assert.deepEqual({ ...process.env }, before);
});

test("A name resolves to the exact file listed, so two cases never share a file", () => {
  // On a case-insensitive file system .env.prod would otherwise open .env.Prod in an earlier folder.
  put(kit(), ".env.Prod", "IBMI_HOST=upper\n");
  put(shared(), ".env.prod", "IBMI_HOST=lower\n");
  assert.deepEqual(listServers(), ["Prod", "prod"]);
  assert.equal(resolveProfileEnv("Prod").IBMI_HOST, "upper");
  assert.equal(resolveProfileEnv("prod").IBMI_HOST, "lower");
});

test("Only regular files with a usable name are servers", () => {
  put(kit(), ".env.default", "IBMI_HOST=d\n"); // `default` is `.env`, so this is ignored
  mkdirSync(join(kit(), ".env.dir"));
  for (const f of [".env.", ".env.pub400.bak", ".env.pub400.orig", ".env.pub400~", ".env.example"]) put(kit(), f, "IBMI_HOST=x\n");
  put(kit(), ".env.ok", "IBMI_HOST=ok\n");
  assert.deepEqual(listServers(), ["ok"]);
  for (const name of [undefined, "default", "dir", "", "pub400.bak", "pub400~"]) {
    assert.throws(() => resolveProfileEnv(name), (e: Error) => e.constructor === Error && /Available: ok$/.test(e.message), String(name));
  }
});

test("Mapepire CA and jar paths never come from the environment", () => {
  put(kit(), ".env.dev", "IBMI_HOST=h\n");
  process.env.IBMI_MAPEPIRE_CA = "/tmp/evil.pem";
  process.env.IBMI_MAPEPIRE_JAR = "/tmp/evil.jar";
  assert.deepEqual(Object.keys(resolveProfileEnv("dev")), ["IBMI_HOST", "IBMI_KIT_PROFILE_FILE"]);
});

test("dot reporter prints a failing test's name and message (quiet-check)", () => {
  const f = join(root, "canary.test.mjs");
  writeFileSync(
    f,
    'import { test } from "node:test";\nimport assert from "node:assert";\n' +
      'test("quiet-check-canary", () => assert.fail("canary-message"));\n',
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // else the child runs as a subtest of this run and exits 0
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=dot", f], { encoding: "utf8", env });
  assert.notEqual(r.status, 0);
  const out = r.stdout + r.stderr;
  assert.match(out, /quiet-check-canary/);
  assert.match(out, /canary-message/);
});

test("dot reporter prints only dots for a passing run (quiet-check)", () => {
  const f = join(root, "passing.test.mjs");
  writeFileSync(f, 'import { test } from "node:test";\ntest("quiet-check-pass", () => {});\n');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=dot", f], { encoding: "utf8", env });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^[.\s]*$/);
});

// ---- credential: helper, store, latch. Fake helpers are node scripts run through process.execPath. ----

const HELPER = `import { appendFileSync, readFileSync } from "node:fs";
const [mode, a, b] = process.argv.slice(2);
if (mode === "out") process.stdout.write(a + (b === "nl" ? "\\r\\n" : ""));
else if (mode === "bom") process.stdout.write("\\uFEFF" + a + "\\n");
else if (mode === "cwd") process.stdout.write(process.cwd());
else if (mode === "fail") { process.stdout.write("TOPSECRET"); process.exit(1); }
else if (mode === "hang") { process.stdout.write("TOPSECRET"); setInterval(() => {}, 1000); }
else if (mode === "big") process.stdout.write("x".repeat(70000));
else if (mode === "seq") { appendFileSync(a, "x"); process.stdout.write("pw" + readFileSync(a, "utf8").length); }
else if (mode === "count") { appendFileSync(a, "x"); process.stdout.write("pw"); }
`;
const helperCmd = (...args: string[]) => {
  const script = join(root, "h.mjs");
  writeFileSync(script, HELPER);
  return [process.execPath, script, ...args].map((x) => `"${x}"`).join(" ");
};
const runCmd = (command: string, o?: { timeoutMs?: number }) => {
  const { file, args } = parseHelperCommand(command);
  return runHelper(file, args, o);
};
const profileFile = () => {
  put(kit(), ".env.dev", "IBMI_HOST=h\n");
  return join(kit(), ".env.dev");
};
const prof = (o: Partial<SignOnProfile> = {}): SignOnProfile => ({ host: "h", user: "u", profileFile: profileFile(), ...o });
const fakeStore = () => {
  const m = new Map<string, string>();
  const calls: string[] = [];
  const s: CredentialStore = {
    get: async (a) => (calls.push(`get ${a}`), m.get(a) ?? null),
    set: async (a, v) => void m.set(a, v),
    delete: async (a) => m.delete(a),
  };
  return { s, m, calls };
};
const captureStderr = async (f: () => Promise<unknown>) => {
  const orig = process.stderr.write;
  let out = "";
  process.stderr.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stderr.write;
  try {
    await f();
  } finally {
    process.stderr.write = orig;
  }
  return out;
};

test("Helper: output sent, one line ending and a BOM removed, trailing space kept", async () => {
  assert.equal(await runCmd(helperCmd("out", "s3cret", "nl")), "s3cret");
  assert.equal(await runCmd(helperCmd("out", "s3cret ")), "s3cret ");
  assert.equal(await runCmd(helperCmd("bom", "s3cret")), "s3cret");
});

test("Helper: failures name only the executable and the reason, never output or arguments", async () => {
  const cases: [string, RegExp][] = [
    [helperCmd("fail", "ARGSECRET"), /exited with code 1/],
    [helperCmd("empty", "ARGSECRET"), /printed nothing/],
    [helperCmd("big", "ARGSECRET"), /more than 64 KiB/],
    [`"${join(root, "no-such-helper")}" ARGSECRET`, /could not start \(ENOENT\)/],
  ];
  for (const [command, re] of cases) {
    await assert.rejects(runCmd(command), (e: Error) => re.test(e.message) && !/TOPSECRET|ARGSECRET/.test(e.message), command);
  }
  await assert.rejects(
    runCmd(helperCmd("hang", "ARGSECRET"), { timeoutMs: 300 }),
    (e: Error) => /timed out/.test(e.message) && !/TOPSECRET|ARGSECRET/.test(e.message),
  );
});

test("Helper: script files are refused before running", () => {
  for (const c of ["C:\\tools\\get.cmd", "x.BAT arg", '"C:\\a b\\get.ps1"']) {
    assert.throws(() => parseHelperCommand(c), /powershell -NoProfile -File <script>/, c);
  }
});

test("Helper: one splitting rule", () => {
  assert.deepEqual(splitCommand('"C:\\Program Files\\x\\get.exe" -File "C:\\new\\y z.ps1"'), [
    "C:\\Program Files\\x\\get.exe", "-File", "C:\\new\\y z.ps1",
  ]);
  assert.deepEqual(splitCommand("a  b\tc"), ["a", "b", "c"]);
  assert.deepEqual(splitCommand("it's 'q' a\\b"), ["it's", "'q'", "a\\b"]);
  assert.deepEqual(splitCommand('a "" b'), ["a", "", "b"]);
  assert.deepEqual(splitCommand('x"y z"w'), ["xy zw"]);
  assert.throws(() => splitCommand('a "b'), /unterminated/);
  assert.throws(() => splitCommand("a\nb"), /one line/);
  assert.throws(() => splitCommand("   "), /empty/);
});

test("Helper: runs with the home folder as its working directory", async () => {
  const cwd = await runCmd(helperCmd("cwd"));
  assert.equal(realpathSync(cwd), realpathSync(home));
});

test("Helper: refused inside a git work tree, store and non-secret reads are not", async () => {
  const clone = join(root, "clone");
  mkdirSync(join(clone, ".git"), { recursive: true });
  const counter = join(root, "count");
  const dir = join(clone, "profiles");
  put(dir, ".env.dev", "IBMI_HOST=h\nIBMI_KIT_PROFILE_FILE=/elsewhere/.env.dev\n");
  process.env.IBMI_KIT_CONFIG_DIR = dir;
  process.env.IBMI_KIT_PROFILE_FILE = "/elsewhere/.env.dev";
  const env = resolveProfileEnv("dev"); // reading the profile works
  assert.equal(env.IBMI_KIT_PROFILE_FILE, join(dir, ".env.dev"));
  const p = { host: "h", user: "u", passwordCommand: helperCmd("count", counter), profileFile: env.IBMI_KIT_PROFILE_FILE };
  await assert.rejects(fetchSecret(p), /inside a git work tree.*IBMI_PASSWORD_STORE=os/s);
  assert.throws(() => readFileSync(counter), "the helper must not have run");
  // a linked work tree has a .git file
  rmSync(join(clone, ".git"), { recursive: true });
  writeFileSync(join(clone, ".git"), "gitdir: x\n");
  await assert.rejects(fetchSecret(p), /git work tree/);
  // the store works there
  const { s, m } = fakeStore();
  setCredentialStore(s);
  m.set("U@h", "stored");
  assert.equal(await fetchSecret({ ...p, passwordCommand: undefined, passwordStore: "os" }), "stored");
});

test("Helper: an unknown profile path is refused", async () => {
  await assert.rejects(fetchSecret({ host: "h", user: "u", passwordCommand: helperCmd("out", "x") }), /profile file is unknown/);
});

test("The environment cannot set a helper or a store, the profile file can", () => {
  put(kit(), ".env.dev", "IBMI_HOST=h\n");
  process.env.IBMI_PASSWORD_COMMAND = "evil";
  process.env.IBMI_PASSWORD_STORE = "os";
  let env = resolveProfileEnv("dev");
  assert.equal(env.IBMI_PASSWORD_COMMAND, undefined);
  assert.equal(env.IBMI_PASSWORD_STORE, undefined);
  put(kit(), ".env.dev", "IBMI_HOST=h\nIBMI_PASSWORD_COMMAND=good\nIBMI_PASSWORD_STORE=os\n");
  env = resolveProfileEnv("dev");
  assert.equal(env.IBMI_PASSWORD_COMMAND, "good");
  assert.equal(passwordSource(env).passwordStore, "os");
});

test("passwordSource: one source needed, only os is a store", () => {
  assert.throws(() => passwordSource({}), /IBMI_PASSWORD_STORE.*IBMI_PASSWORD_COMMAND/);
  assert.throws(() => passwordSource({ IBMI_PASSWORD_STORE: "file" }), /must be "os"/);
  assert.deepEqual(passwordSource({ IBMI_PASSWORD: "p", IBMI_KIT_PROFILE_FILE: "f" }), {
    password: "p", passwordCommand: undefined, passwordStore: undefined, profileFile: "f",
  });
});

test("Precedence helper, store, plain line; no fallback; the plain line warns once", async () => {
  const { s, m, calls } = fakeStore();
  setCredentialStore(s);
  m.set("U@h", "from-store");
  const all = prof({ passwordCommand: helperCmd("out", "from-helper"), passwordStore: "os", password: "plain" });
  let err = await captureStderr(async () => {
    assert.equal(await fetchSecret(all), "from-helper");
    assert.equal(await fetchSecret(all), "from-helper");
  });
  assert.deepEqual(calls, []); // the store was not read
  assert.equal((err.match(/ignored/g) ?? []).length, 1);
  assert.ok(err.includes(all.profileFile!) && !/from-helper|plain"/.test(err));
  resetSignOnState();
  err = await captureStderr(async () => assert.equal(await fetchSecret(prof({ passwordStore: "os", password: "plain" })), "from-store"));
  assert.match(err, /ignored/);
  resetSignOnState();
  err = await captureStderr(async () => assert.equal(await fetchSecret(prof({ password: "plain" })), "plain"));
  assert.match(err, /plain IBMI_PASSWORD/);
  assert.ok(!err.includes("plain\n"));
  // no fallback: a failing helper does not send the plain line
  await assert.rejects(fetchSecret(prof({ passwordCommand: helperCmd("fail"), password: "plain" })), /exited with code 1/);
  assert.equal(lastSecret("h", "u"), "plain"); // only the successful fetch is remembered
});

test("Store: account is USER@host, an edited host finds no entry, errors point at the way out", async () => {
  const { s, m } = fakeStore();
  setCredentialStore(s);
  assert.equal(credentialAccount("dev1", "Pub400.Example.COM"), "DEV1@pub400.example.com");
  await storeSecret("dev1", "Pub400.Example.COM", "pw1");
  assert.equal(m.get("DEV1@pub400.example.com"), "pw1");
  const p = { host: "pub400.example.com", user: "Dev1", passwordStore: "os" as const };
  assert.equal(await fetchSecret(p), "pw1");
  await assert.rejects(fetchSecret({ ...p, host: "new.example.com" }), (e: Error) => /DEV1@new\.example\.com/.test(e.message) && /credential set/.test(e.message) && /IBMI_PASSWORD_COMMAND/.test(e.message) && !e.message.includes("pw1"));
  assert.equal(await deleteStoredSecret("DEV1", "pub400.example.com"), true);
  setCredentialStore({
    get: async () => { throw new Error("no Secret Service"); },
    set: async (_a, v) => { throw new Error(`no Secret Service for ${v}`); },
    delete: async () => { throw new Error("no Secret Service"); },
  });
  await assert.rejects(fetchSecret(p), /cannot be read \(no Secret Service\).*IBMI_PASSWORD_COMMAND/s);
  await assert.rejects(storeSecret("u", "h", "TOPSECRET"), (e: Error) => /IBMI_PASSWORD_COMMAND/.test(e.message) && !e.message.includes("TOPSECRET"));
  await assert.rejects(deleteStoredSecret("u", "h"), /IBMI_PASSWORD_COMMAND/);
});

test("Fetching reads the helper once per send; a rotated password is picked up; reading a profile runs nothing", async () => {
  const counter = join(root, "count");
  const p = prof({ passwordCommand: helperCmd("seq", counter) });
  put(kit(), ".env.dev", `IBMI_HOST=h\nIBMI_PASSWORD_COMMAND='${p.passwordCommand}'\n`);
  resolveProfileEnv("dev");
  assert.throws(() => readFileSync(counter), "resolveProfileEnv must not run the helper");
  const sent: string[] = [];
  const send = async (s: string) => void sent.push(s);
  await signOnOnce(p, send, () => false);
  assert.equal(readFileSync(counter, "utf8").length, 1);
  await signOnOnce(p, send, () => false);
  assert.deepEqual(sent, ["pw1", "pw2"]);
  assert.equal(lastSecret("h", "u"), "pw2");
});

test("Latch: a rejected password is not sent again; a changed one is; success clears", async () => {
  const { s, m } = fakeStore();
  setCredentialStore(s);
  const p = prof({ passwordStore: "os" });
  m.set("U@h", "a");
  const sent: string[] = [];
  const auth = (e: unknown) => /401/.test(String(e));
  const bad = async (x: string) => (sent.push(x), Promise.reject(new Error("401")));
  const good = async (x: string) => (sent.push(x), "ok");
  await assert.rejects(signOnOnce(p, bad, auth), /401/);
  await assert.rejects(signOnOnce(p, good, auth), /not sent.*rejected earlier.*restart/s);
  assert.deepEqual(sent, ["a"]);
  m.set("U@h", "b"); // corrected, no restart
  assert.equal(await signOnOnce(p, good, auth), "ok");
  m.set("U@h", "a"); // success cleared the record, so "a" is tried again
  assert.equal(await signOnOnce(p, good, auth), "ok");
  assert.deepEqual(sent, ["a", "b", "a"]);
});

test("Latch: a plain profile latches too; a failure that is not authentication does not", async () => {
  const p = prof({ password: "pw" });
  let n = 0;
  const down = async () => (n++, Promise.reject(new Error("ECONNREFUSED")));
  await captureStderr(async () => {
    await assert.rejects(signOnOnce(p, down, (e) => /401/.test(String(e))), /ECONNREFUSED/);
    await assert.rejects(signOnOnce(p, down, (e) => /401/.test(String(e))), /ECONNREFUSED/);
    assert.equal(n, 2);
    const bad = async () => (n++, Promise.reject(new Error("401")));
    await assert.rejects(signOnOnce(p, bad, () => true), /401/);
    await assert.rejects(signOnOnce(p, bad, () => true), /not sent/);
    assert.equal(n, 3);
  });
});

test("Latch: concurrent sign-ons for one user and host send once; other users are not held back", async () => {
  const p = prof({ password: "pw" });
  const other = prof({ password: "pw", user: "other" });
  let n = 0;
  const slowBad = async () => {
    n++;
    await new Promise((r) => setTimeout(r, 80));
    throw new Error("401");
  };
  await captureStderr(async () => {
    const r = await Promise.allSettled([
      signOnOnce(p, slowBad, () => true),
      signOnOnce(p, slowBad, () => true),
      signOnOnce(p, slowBad, () => true),
    ]);
    assert.equal(n, 1);
    assert.deepEqual(r.map((x) => x.status), ["rejected", "rejected", "rejected"]);
    assert.equal(await signOnOnce(other, async () => "fine", () => true), "fine");
  });
});

test("No error from a failed fetch holds a secret", async () => {
  await assert.rejects(
    signOnOnce(prof({ passwordCommand: helperCmd("fail", "ARGSECRET") }), async () => "never", () => false),
    (e: Error) => /exited with code 1/.test(e.message) && !/TOPSECRET|ARGSECRET/.test(e.message),
  );
});

test("@napi-rs/keyring loads and builds an entry on this platform, without touching the store", async () => {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  assert.equal(typeof new AsyncEntry("ibmi-agent-kit-selfcheck", "nobody@nowhere"), "object");
});
