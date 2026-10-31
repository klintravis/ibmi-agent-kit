import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIRS, listServers, resolveProfileEnv } from "./index.js";

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
});
afterEach(() => {
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
    "IBMI_MAPEPIRE_PORT",
  ]) process.env[k] = "false";
  process.env.IBMI_HOST = "evil";
  const env = resolveProfileEnv("dev");
  assert.equal(env.IBMI_HOST, "h");
  assert.deepEqual(Object.keys(env), ["IBMI_HOST"]);
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
  assert.deepEqual(Object.keys(resolveProfileEnv("dev")), ["IBMI_HOST"]);
});
