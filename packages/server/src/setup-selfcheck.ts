// `setup` (first-run 1.3): a fake terminal and a fake connection, profile folders in a temp dir, so
// no real profile is read or written and no IBM i is contacted. Imported by selfcheck.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSecret, parseHelperCommand, passwordSource, resetSignOnState, resolveProfileEnv, setCredentialStore, type CredentialStore } from "@ibmi-agent-kit/core";
import { credentialCli } from "./credential-cli.js";
import { SETUP_SQL, setupCli, type Input, type Probe } from "./setup-cli.js";

const POLICY = fileURLToPath(new URL("../../../examples/demo/policy-observe.yaml", import.meta.url));
const HOSTILE = `p#w=d s$x'y"z`;
const SKELPW = "skel-pw-9";
const OLDPW = "old-host-pw-7";
const HELPERPW = "helper-pw-5#x";
const PASSWORDS = [HOSTILE, "plainpw", "s3cret#2", SKELPW, OLDPW, HELPERPW, "rot-pw-1", "tty-pw-3", "carolpw", "failpw", "oldplain", "dup-pw-4", "argvpw"];
const captured: string[] = [];

// No selfcheck reaches the real OS store: every setup and credential run goes through this fake.
const vault = new Map<string, string>();
let failSet: Error | undefined;
const fake: CredentialStore = {
  get: async (a) => vault.get(a) ?? null,
  set: async (a, s) => {
    if (failSet) throw failSet;
    vault.set(a, s);
  },
  delete: async (a) => vault.delete(a),
};

// A terminal that sends one scripted chunk each time a prompt starts reading.
class FakeTty extends EventEmitter implements Input {
  isTTY = true;
  raw = false;
  constructor(private chunks: string[]) {
    super();
  }
  setRawMode(on: boolean) {
    this.raw = on;
  }
  setEncoding() {}
  pause() {}
  resume() {
    const c = this.chunks.shift();
    if (c !== undefined) setImmediate(() => this.emit("data", c));
  }
}

async function run(args: string[], keys: string[], connect: (env: Record<string, string>) => Probe = okProbe, tty = true, cwd?: string) {
  const input = new FakeTty(keys);
  input.isTTY = tty;
  let out = "";
  let err = "";
  const code = await setupCli(args, { input, out: (t) => void (out += t), err: (t) => void (err += t), connect, cwd, store: fake });
  captured.push(out, err);
  assert.equal(input.raw, false, "raw mode left on");
  return { code, out, err };
}

const seen: Record<string, string>[] = [];
function okProbe(env: Record<string, string>): Probe {
  seen.push(env);
  return {
    query: async (sql) => (assert.equal(sql, SETUP_SQL), { rows: [{ "00001": "BOB       ", "00002": "MYRDB" }] }),
    close: async () => {},
  };
}

// Profile folders in a temp dir, home included, so CONFIG_DIRS() never names a real folder.
async function isolated(body: (dir: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "kit-setup-"));
  const saved = { ...process.env };
  vault.clear();
  failSet = undefined;
  setCredentialStore(fake);
  resetSignOnState();
  for (const k of Object.keys(process.env)) if (k.startsWith("IBMI_")) delete process.env[k];
  Object.assign(process.env, { IBMI_KIT_CONFIG_DIR: join(root, "config"), HOME: root, USERPROFILE: root });
  try {
    await body(join(root, "config"));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}

test("setup: a new profile is written, read back from the file and tested", () =>
  isolated(async (dir) => {
    seen.length = 0;
    const r = await run(["dev"], ["box.example.com\r", "ab\u007fc\r", "\r", HOSTILE + "\r", "\r"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /OK: dev signs on as BOB to MYRDB\n$/);
    const env = resolveProfileEnv("dev");
    assert.equal(env.IBMI_HOST, "box.example.com");
    assert.equal(env.IBMI_USER, "ac", "Backspace edits");
    const text = readFileSync(join(dir, ".env.dev"), "utf8");
    assert.equal(env.IBMI_PASSWORD_STORE, "os", "Enter at the source prompt chooses the OS store");
    assert.equal(env.IBMI_PASSWORD, undefined);
    assert.ok(!text.includes(HOSTILE) && !/IBMI_PASSWORD=/.test(text), "no password in the file:\n" + text);
    assert.equal(vault.get("AC@box.example.com"), HOSTILE, "the password went to the (fake) store");
    assert.equal(env.IBMI_KIT_POLICY, undefined, "Enter leaves the policy unset");
    assert.equal(seen[0].IBMI_PASSWORD_STORE, "os", "the test connects with the file's values");
    assert.deepEqual(readdirSync(dir), [".env.dev"], "no temp file left");
    if (process.platform !== "win32") assert.equal(statSync(join(dir, ".env.dev")).mode & 0o777, 0o600);
  }));

test("setup: no name writes .env; answers pasted in one chunk are taken prompt by prompt", () =>
  isolated(async (dir) => {
    const r = await run([], ["h1\ru1\r\rplainpw\r\r"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(existsSync(join(dir, ".env")));
    assert.equal(resolveProfileEnv().IBMI_USER, "u1");
  }));

test("setup: an update keeps other lines and comments, Enter keeps values, the policy path becomes absolute", () =>
  isolated(async (dir) => {
    mkdirSync(dir, { recursive: true });
    const before = ["# prod box, ask ops before changing", "IBMI_HOST=old.example.com", "export IBMI_USER=olduser", "IBMI_SSH_PORT=2222 # jump host", "IBMI_PASSWORD='s3cret#2'", "", "# trailing note", "IBMI_USER=dupe", ""].join("\n");
    writeFileSync(join(dir, ".env.prod"), before);
    // on Windows the path holds `\n` (as in `...\new\policy.yaml`), which double quotes would expand
    const policy = join(dir, "new", "policy.yaml");
    mkdirSync(join(dir, "new"));
    copyFileSync(POLICY, policy);
    const r = await run(["prod"], ["\r", "newuser\r", "\r", "newpw1\r", relative(process.cwd(), policy) + "\r"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /\[old\.example\.com\]/, "current values are offered");
    assert.match(r.out, /\npassword: /, "a new user never keeps the old password");
    assert.doesNotMatch(r.out, /is replaced by|Enter keeps the current one/);
    const text = readFileSync(join(dir, ".env.prod"), "utf8");
    for (const keep of ["# prod box, ask ops before changing", "IBMI_SSH_PORT=2222 # jump host", "# trailing note"]) assert.ok(text.includes(keep), text);
    const env = resolveProfileEnv("prod");
    assert.equal(env.IBMI_HOST, "old.example.com");
    assert.equal(env.IBMI_USER, "newuser", "every line setting the key is replaced:\n" + text);
    assert.equal(env.IBMI_PASSWORD, undefined, "the plain line is gone:\n" + text);
    assert.equal(env.IBMI_PASSWORD_STORE, "os");
    assert.equal(vault.get("NEWUSER@old.example.com"), "newpw1");
    assert.ok(![...vault.values()].includes("s3cret#2"), "the old user's password is not carried over");
    assert.equal(env.IBMI_SSH_PORT, "2222");
    assert.equal(env.IBMI_KIT_POLICY, policy);
  }));

test("setup: bad names, extra arguments and a non-terminal are refused before anything is asked or written", () =>
  isolated(async (dir) => {
    for (const name of ["", "example", "x.bak", "x.orig", "x~", "../x", "a/b", "a\\b", "a..b", "x.", ".hidden", "a b", "a:b"]) {
      const r = await run([name], []);
      assert.equal(r.code, 2, name);
      assert.match(r.err, /cannot be a profile name/, name);
    }
    assert.equal((await run(["a", "b"], [])).code, 2);
    // `Prod` next to `.env.prod`: refused on a case-insensitive file system, a separate file elsewhere
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env.prod"), "IBMI_USER=keep\n");
    await run(["Prod"], ["h\r", "u\r", "\r", "plainpw\r", "\r"]);
    assert.equal(readFileSync(join(dir, ".env.prod"), "utf8"), "IBMI_USER=keep\n", "another server's file was changed");
    rmSync(dir, { recursive: true, force: true });
    const r = await run(["dev"], ["h\r", "u\r", "\r", "plainpw\r", "\r"], okProbe, false);
    assert.equal(r.code, 2);
    assert.match(r.err, /needs a real terminal/);
    assert.equal(r.out, "", "nothing asked");
    assert.equal(existsSync(dir), false, "nothing written");
  }));

test("setup: Ctrl-C and values dotenv cannot hold write nothing", () =>
  isolated(async (dir) => {
    const c = await run(["dev"], ["h\r", "u\r", "\u0003"]);
    assert.equal(c.code, 130);
    assert.match(c.err, /cancelled, nothing written/);
    // a literal \n (double quotes would expand it) next to both ' and `: no quote fits
    const q = await run(["dev"], ["h\r", "u\r", `node a\\nb'c\`` + "\r", "\r"]);
    assert.equal(q.code, 2);
    assert.match(q.err, /IBMI_PASSWORD_COMMAND cannot be written safely/);
    assert.equal(existsSync(join(dir, ".env.dev")), false);
    assert.equal(vault.size, 0);
  }));

test("setup: a failed connection prints one line without the password; the file stays", () =>
  isolated(async (dir) => {
    let closed = false;
    const failing = (): Probe => ({
      query: async () => {
        throw new Error(`login failed for {"password":${JSON.stringify(HOSTILE)}} raw=${HOSTILE} url=${encodeURIComponent(HOSTILE)}`);
      },
      close: async () => void (closed = true),
    });
    const r = await run(["dev"], ["h\r", "u\r", "\r", HOSTILE + "\r", "\r"], failing);
    assert.equal(r.code, 1);
    assert.match(r.out, /\nfailed: login failed for .*\*\*\*/);
    assert.ok(closed, "the connection is closed");
    assert.ok(existsSync(join(dir, ".env.dev")));
    const before = readFileSync(join(dir, ".env.dev"), "utf8");
    const p = await run(["dev"], ["\r", "\r", "\r", "\r", join(dir, "missing.yaml") + "\r"]);
    assert.equal(p.code, 2);
    assert.match(p.err, /IBMI_KIT_POLICY .*policy file not found.*Nothing was written/);
    assert.equal(readFileSync(join(dir, ".env.dev"), "utf8"), before, "a bad policy answer is not saved");
    assert.equal(resolveProfileEnv("dev").IBMI_KIT_POLICY, undefined);
  }));

test("setup: a quoted policy path and a ~ path are cleaned before they are saved", () =>
  isolated(async (dir) => {
    const home = process.env.HOME!;
    copyFileSync(POLICY, join(home, "pol.yaml"));
    const q = await run(["dev"], ["h\r", "u\r", "\r", "plainpw\r", `"${join(home, "pol.yaml")}"\r`]);
    assert.equal(q.code, 0, q.out + q.err);
    assert.equal(resolveProfileEnv("dev").IBMI_KIT_POLICY, join(home, "pol.yaml"));
    const t = await run(["dev"], ["\r", "\r", "\r", "\r", "~/pol.yaml\r"]);
    assert.equal(t.code, 0, t.out + t.err);
    assert.equal(resolveProfileEnv("dev").IBMI_KIT_POLICY, join(home, "pol.yaml"));
    assert.ok(existsSync(dir));
  }));

// team-onboarding: setup in a company config repo (policy.yaml and profiles/ in the current folder).
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MCP = (arg: string) => JSON.stringify({ mcpServers: { "ibmi-agent-kit": { command: "node", args: [arg] } } });
const MCP_HOME = MCP("${IBMI_KIT_HOME}/packages/server/dist/index.js"); // a plain string: the variable stays as text
const skel = (p: string) => `# skeleton\nIBMI_HOST=k${p}.example.com\nIBMI_USER=YOUR_USER\nIBMI_PARTITION=${p}\n`;

function companyRepo(root: string, skeletons: Record<string, string>, mcp = MCP_HOME) {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "profiles"), { recursive: true });
  copyFileSync(POLICY, join(repo, "policy.yaml"));
  writeFileSync(join(repo, ".mcp.json"), mcp);
  for (const [f, text] of Object.entries(skeletons)) writeFileSync(join(repo, "profiles", f), text);
  return repo;
}
// Every file of the repo and of profiles/ with its text: setup writes no file, so two levels cover it.
const snapshot = (repo: string) =>
  JSON.stringify([repo, join(repo, "profiles")].map((d) => readdirSync(d).sort().map((f) => [f, statSync(join(d, f)).isFile() ? readFileSync(join(d, f), "utf8") : "dir"])));

test("setup in a company repo: the skeleton's settings, the repo's policy path, no skeleton password, the repo unchanged", () =>
  isolated(async (dir) => {
    // A skeleton helper that would leave a marker file if anything ran it.
    const marker = join(dirname(dir), "skeleton-helper-ran");
    const helper = join(dirname(dir), "skeleton-helper.js");
    writeFileSync(helper, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); console.log("x");`);
    const dev = ["# skeleton", "IBMI_HOST=kdev01.example.com", "IBMI_USER=YOUR_USER", "IBMI_SQL_TRANSPORT=mapepire", "IBMI_PARTITION=dev", "IBMI_KIT_POLICY=/admin/only/policy.yaml", `IBMI_PASSWORD=${SKELPW}`, `IBMI_PASSWORD_COMMAND=node "${helper}"`, ""].join("\n");
    const repo = companyRepo(dirname(dir), { ".env.dev": dev, ".env.prod": skel("prod"), ".env.example": skel("example") });
    const before = snapshot(repo);
    seen.length = 0;
    const r = await run(["dev"], ["bob\r", "\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(r.out.includes(`company config repo: ${repo}`), r.out);
    assert.match(r.out, /\nIBM i user: bob/, "the placeholder user is not offered");
    assert.doesNotMatch(r.out, /YOUR_USER|IBM i host|policy file/, "host and policy are not asked");
    assert.match(r.err, /\.env\.dev holds a password\. It is ignored/);
    assert.match(r.err, /\.env\.dev holds IBMI_PASSWORD_COMMAND\. It is ignored, never copied or run/);
    assert.equal(existsSync(marker), false, "the skeleton's helper ran");
    assert.ok(!readFileSync(join(dir, ".env.dev"), "utf8").includes("skeleton-helper"), "the skeleton's helper was copied");
    assert.ok(r.out.includes(`set it to ${KIT}`), r.out);
    const env = resolveProfileEnv("dev");
    assert.equal(env.IBMI_HOST, "kdev01.example.com");
    assert.equal(env.IBMI_PARTITION, "dev");
    assert.equal(env.IBMI_SQL_TRANSPORT, "mapepire", "a non-credential skeleton key is copied");
    assert.equal(env.IBMI_USER, "bob");
    assert.equal(env.IBMI_PASSWORD, undefined, "the skeleton's password is never written");
    assert.equal(env.IBMI_PASSWORD_COMMAND, undefined);
    assert.equal(env.IBMI_PASSWORD_STORE, "os");
    assert.equal(vault.get("BOB@kdev01.example.com"), "plainpw");
    assert.equal(env.IBMI_KIT_POLICY, join(repo, "policy.yaml"));
    assert.ok(isAbsolute(env.IBMI_KIT_POLICY));
    assert.equal(seen[0].IBMI_SQL_TRANSPORT, "mapepire", "the test connects with the copied transport");
    assert.ok(!readFileSync(join(dir, ".env.dev"), "utf8").includes(SKELPW));
    const after = snapshot(repo);
    assert.equal(after, before, "a repo file changed");
    assert.ok(!after.includes("plainpw"));

    // A second run offers the user, keeps the password, and replaces another policy path.
    writeFileSync(join(dir, ".env.dev"), readFileSync(join(dir, ".env.dev"), "utf8") + "IBMI_KIT_POLICY=/elsewhere/policy.yaml\n");
    const again = await run(["dev"], ["\r", "\r", "\r"], okProbe, true, repo);
    assert.match(again.out, /password \(Enter keeps the current one\): /, "same host and user keep the store entry");
    assert.equal(again.code, 0, again.out + again.err);
    assert.match(again.out, /\[bob\]/);
    assert.ok(again.out.includes(`IBMI_KIT_POLICY /elsewhere/policy.yaml is replaced by ${join(repo, "policy.yaml")}`), again.out);
    assert.equal(resolveProfileEnv("dev").IBMI_KIT_POLICY, join(repo, "policy.yaml"));
    assert.equal(vault.get("BOB@kdev01.example.com"), "plainpw");
    assert.equal(snapshot(repo), before);
  }));

test("setup in a company repo: a profile on another host never keeps its password", () =>
  isolated(async (dir) => {
    const repo = companyRepo(dirname(dir), { ".env.dev": skel("dev") });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env.dev"), `IBMI_HOST=old.example.com\nIBMI_USER=bob\nIBMI_PASSWORD=${OLDPW}\n`);
    seen.length = 0;
    const r = await run(["dev"], ["\r", "\r", "\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /partition dev on host kdev\.example\.com\n[^]*IBMI_HOST old\.example\.com is replaced by kdev\.example\.com\n[^]*IBM i user/);
    assert.match(r.out, /\npassword: \npassword: \n/, "Enter does not keep the old host's password");
    assert.doesNotMatch(r.out, /Enter keeps the current one/);
    assert.ok(seen.every((e) => e.IBMI_PASSWORD !== OLDPW), "the old host's password was sent");
    assert.ok(!readFileSync(join(dir, ".env.dev"), "utf8").includes(OLDPW));
    assert.equal(resolveProfileEnv("dev").IBMI_HOST, "kdev.example.com");
    assert.equal(vault.get("BOB@kdev.example.com"), "plainpw");
    assert.equal(vault.has("BOB@old.example.com"), false);
  }));

test("setup in a company repo: several partitions are offered, one is taken as is", () =>
  isolated(async (dir) => {
    const repo = companyRepo(dirname(dir), { ".env.dev": skel("dev"), ".env.prod": skel("prod"), ".env.example": skel("example"), ".env.prod.bak": skel("old") });
    const m = await run([], ["x\r", "2\r", "bob\r", "\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(m.code, 0, m.out + m.err);
    assert.match(m.out, / {2}1\. dev\n {2}2\. prod\npartition \(number or name\): x\npartition/, "listed by the loader's rules; a wrong answer asks again");
    assert.deepEqual(readdirSync(dir), [".env.prod"]);
    assert.equal(resolveProfileEnv("prod").IBMI_HOST, "kprod.example.com");
    const n = await run([], ["dev\r", "bob\r", "\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(n.code, 0, n.out + n.err);
    assert.equal(resolveProfileEnv("dev").IBMI_PARTITION, "dev", "answered by name");
    rmSync(join(repo, "profiles", ".env.prod"));
    rmSync(join(dir, ".env.dev"));
    const s = await run([], ["bob\r", "\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(s.code, 0, s.out + s.err);
    assert.doesNotMatch(s.out, /partition \(/);
    assert.equal(resolveProfileEnv("dev").IBMI_HOST, "kdev.example.com");
  }));

test("setup in a company repo: unknown names, a profile folder in the repo, bad skeletons and policies write nothing", () =>
  isolated(async (dir) => {
    const repo = companyRepo(dirname(dir), { ".env.dev": skel("dev"), ".env.prod": skel("prod") });
    const before = snapshot(repo);
    const u = await run(["qa"], [], okProbe, true, repo);
    assert.equal(u.code, 2);
    assert.match(u.err, /"qa" is not a partition .*partitions: dev, prod\. Nothing was written/);
    for (const inside of [join(repo, "cfg"), repo]) {
      process.env.IBMI_KIT_CONFIG_DIR = inside;
      const i = await run(["dev"], ["bob\r", "\r", "plainpw\r"], okProbe, true, repo);
      assert.equal(i.code, 2, inside);
      assert.match(i.err, /inside the company config repo .*Nothing was written/);
      assert.equal(i.out, "", "refused before the first prompt");
      assert.equal(snapshot(repo), before);
    }
    // A profile folder outside the repo that links into it (a junction needs no admin on Windows).
    const linked = join(dirname(dir), "linked");
    symlinkSync(join(repo, "profiles"), linked, "junction");
    process.env.IBMI_KIT_CONFIG_DIR = linked;
    const l = await run(["dev"], ["bob\r", "\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(l.code, 2);
    assert.match(l.err, /inside the company config repo .*Nothing was written/);
    assert.equal(snapshot(repo), before);
    // The repo spelt in another case: runs only where the temp file system ignores case (Windows, macOS).
    const spelt = join(dirname(repo), "REPO");
    if (existsSync(spelt)) {
      process.env.IBMI_KIT_CONFIG_DIR = join(spelt, "cfg");
      const c = await run(["dev"], ["bob\r", "\r", "plainpw\r"], okProbe, true, repo);
      assert.equal(c.code, 2, c.out + c.err);
      assert.match(c.err, /inside the company config repo .*Nothing was written/);
      assert.equal(snapshot(repo), before);
    }
    process.env.IBMI_KIT_CONFIG_DIR = dir;
    writeFileSync(join(repo, "profiles", ".env.qa"), "IBMI_PARTITION=qa\n");
    const h = await run(["qa"], [], okProbe, true, repo);
    assert.equal(h.code, 2);
    assert.match(h.err, /\.env\.qa sets no IBMI_HOST\. Nothing was written/);
    writeFileSync(join(repo, "policy.yaml"), "version: [not a policy\n");
    const p = await run(["dev"], ["bob\r", "\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(p.code, 2);
    assert.match(p.err, /IBMI_KIT_POLICY .*Nothing was written/);
    for (const f of readdirSync(join(repo, "profiles"))) rmSync(join(repo, "profiles", f));
    const none = await run([], [], okProbe, true, repo);
    assert.equal(none.code, 2);
    assert.match(none.err, /no profile skeleton/);
    assert.equal(existsSync(dir), false, "nothing written");
  }));

test("setup in a company repo: the IBMI_KIT_HOME hint only when .mcp.json uses it and it is unset; no repo, no repo mode", () =>
  isolated(async (dir) => {
    const repo = companyRepo(dirname(dir), { ".env.dev": skel("dev") }, MCP("/opt/kit/packages/server/dist/index.js"));
    const a = await run([], ["bob\r", "\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(a.code, 0, a.out + a.err);
    assert.doesNotMatch(a.out, /IBMI_KIT_HOME/);
    writeFileSync(join(repo, ".mcp.json"), MCP_HOME);
    process.env.IBMI_KIT_HOME = KIT;
    const b = await run([], ["\r", "\r", "\r"], okProbe, true, repo);
    assert.equal(b.code, 0, b.out + b.err);
    assert.doesNotMatch(b.out, /IBMI_KIT_HOME/);
    rmSync(join(repo, "profiles"), { recursive: true });
    const c = await run(["other"], ["h\r", "u\r", "\r", "plainpw\r", "\r"], okProbe, true, repo);
    assert.equal(c.code, 0, c.out + c.err);
    assert.match(c.out, /IBM i host: h/);
    assert.doesNotMatch(c.out, /company config repo/);
  }));

test("setup: a profile on another host never keeps its password", () =>
  isolated(async (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env.prod"), `IBMI_HOST=old.example.com\nIBMI_USER=bob\nIBMI_PASSWORD=${OLDPW}\n`);
    seen.length = 0;
    // host, user kept, store chosen, Enter at the password rejected, password, policy left
    const r = await run(["prod"], ["new.example.com\r", "\r", "\r", "\r", "plainpw\r", "\r"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /IBMI_HOST old\.example\.com is replaced by new\.example\.com\n/);
    assert.match(r.out, /\npassword: \npassword: \n/, "Enter does not keep the old host's password");
    assert.doesNotMatch(r.out, /Enter keeps the current one/);
    assert.ok(seen.every((e) => e.IBMI_PASSWORD !== OLDPW), "the old host's password was sent");
    assert.ok(!readFileSync(join(dir, ".env.prod"), "utf8").includes(OLDPW));
    const env = resolveProfileEnv("prod");
    assert.deepEqual([env.IBMI_HOST, env.IBMI_USER, env.IBMI_PASSWORD, env.IBMI_PASSWORD_STORE], ["new.example.com", "bob", undefined, "os"]);
    assert.deepEqual([...vault], [["BOB@new.example.com", "plainpw"]], "only the new host's entry; the old plain line is gone, not migrated");
    // a profile with a password but no host never offers it either
    writeFileSync(join(dir, ".env.nohost"), `IBMI_USER=bob\nIBMI_PASSWORD=${OLDPW}\n`);
    seen.length = 0;
    const n = await run(["nohost"], ["h.example.com\r", "\r", "\r", "\r", "plainpw\r", "\r"]);
    assert.equal(n.code, 0, n.out + n.err);
    assert.doesNotMatch(n.out, /Enter keeps the current one|is replaced by/);
    assert.ok(seen.every((e) => e.IBMI_PASSWORD !== OLDPW), "the old password was sent");
    assert.ok(!readFileSync(join(dir, ".env.nohost"), "utf8").includes(OLDPW));
  }));

// ---- password source: helper, migration, store failure, `credential` ----

// A helper script in a folder with a space in its name, under the temp root and never the checkout (a
// git work tree, where a helper is refused). Returns the command line that runs it; with `marker` each run
// appends one "x" to that file, so a test can count the runs.
function helperCommand(root: string, secret: string, marker?: string): string {
  const script = join(root, "my helper", "h.js");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, (marker ? `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");` : "") + `console.log(${JSON.stringify(secret)});`);
  return `"${process.execPath}" "${script}"`;
}

// A connection whose sign-on fetches the password the way the real one does, so the helper runs for it.
const fetchingProbe = (env: Record<string, string>): Probe => ({
  query: async (sql) => {
    await fetchSecret({ ...passwordSource(env), host: env.IBMI_HOST, user: env.IBMI_USER });
    return okProbe(env).query(sql);
  },
  close: async () => {},
});

const profile = (dir: string, name: string, text: string) => (mkdirSync(dir, { recursive: true }), writeFileSync(join(dir, `.env.${name}`), text));

test("setup: a helper is written as the only source, never run for the write, and its secret is masked in the test", () =>
  isolated(async (dir) => {
    const cmd = helperCommand(dirname(dir), HELPERPW);
    const rejecting = (env: Record<string, string>): Probe => ({
      query: async () => {
        const secret = await fetchSecret({ ...passwordSource(env), host: env.IBMI_HOST, user: env.IBMI_USER });
        throw new Error(`sign-on failed for ${env.IBMI_USER} with ${secret} (${encodeURIComponent(secret)})`);
      },
      close: async () => {},
    });
    const r = await run(["dev"], ["h.example.com\r", "bob\r", cmd + "\r", "\r"], rejecting);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /failed: sign-on failed for bob with \*\*\* \(\*\*\*\)\n/, "the helper's secret is masked");
    const env = resolveProfileEnv("dev");
    assert.equal(env.IBMI_PASSWORD_COMMAND, cmd, "the Windows path, the spaces and the quotes survive the round trip");
    assert.equal(env.IBMI_PASSWORD_STORE, undefined);
    assert.equal(env.IBMI_PASSWORD, undefined);
    assert.equal(vault.size, 0, "a helper never touches the store");
    assert.ok(!readFileSync(join(dir, ".env.dev"), "utf8").includes(HELPERPW));
  }));

test("setup: a helper command is written back exactly or refused before any write", () =>
  isolated(async (dir) => {
    const win = String.raw`"C:\Program Files\node js\node.exe" "C:\Users\A B\new\run\h.js" --flag`; // \n and \r inside double quotes
    const cases: [string, string | RegExp][] = [
      [win, "ok"],
      [`node "C:\\x y\\p#w.js" arg`, "ok"], // a # inside quotes
      [`node "it's a path\\h.js" a`, "ok"], // ' and " together: a backtick wraps it
      [`node "it's a \`path\\h.js"`, /IBMI_PASSWORD_COMMAND cannot be written safely/], // ' " and `: no quote fits
      [`node "unbalanced`, /Nothing was written/],
      [String.raw`C:\tools\get-pw.cmd`, /Nothing was written/],
      [String.raw`C:\tools\get-pw.BAT`, /Nothing was written/],
    ];
    for (const [i, [cmd, want]] of cases.entries()) {
      const r = await run([`h${i}`], ["h.example.com\r", "bob\r", cmd + "\r", "\r"]);
      const file = join(dir, `.env.h${i}`);
      if (want === "ok") {
        assert.equal(r.code, 0, cmd + "\n" + r.out + r.err);
        assert.equal(resolveProfileEnv(`h${i}`).IBMI_PASSWORD_COMMAND, cmd, readFileSync(file, "utf8"));
        assert.deepEqual(parseHelperCommand(resolveProfileEnv(`h${i}`).IBMI_PASSWORD_COMMAND), parseHelperCommand(cmd));
      } else {
        assert.equal(r.code, 2, cmd + "\n" + r.out + r.err);
        assert.match(r.err, want as RegExp, cmd);
        assert.equal(existsSync(file), false, `a refused command wrote ${file}`);
      }
    }
    assert.equal(vault.size, 0);
  }));

test("setup: a helper is refused in a git work tree and nothing is written or stored", () =>
  isolated(async (dir) => {
    const wt = join(dirname(dir), "wt");
    mkdirSync(join(wt, ".git"), { recursive: true });
    process.env.IBMI_KIT_CONFIG_DIR = join(wt, "profiles");
    const r = await run(["dev"], ["h.example.com\r", "bob\r", helperCommand(dirname(dir), "x") + "\r"]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /cannot be used for .*git work tree.*Nothing was written/s);
    assert.equal(existsSync(join(wt, "profiles")), false);
    assert.equal(vault.size, 0);
  }));

test("setup: a plain password is migrated to the store and its line removed; other lines stay", () =>
  isolated(async (dir) => {
    profile(dir, "dev", ["# mine", "IBMI_HOST=h.example.com", "IBMI_USER=bob", "IBMI_PASSWORD=oldplain", "export IBMI_PASSWORD='dup-pw-4'","IBMI_SSH_PORT=2222", ""].join("\n"));
    const r = await run(["dev"], ["\r", "\r", "\r", "\r", "\r"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /password \(Enter keeps the current one\): /);
    const text = readFileSync(join(dir, ".env.dev"), "utf8");
    assert.ok(!/IBMI_PASSWORD=|oldplain|dup-pw-4/.test(text), text);
    assert.match(text, /^# mine\n/);
    assert.match(text, /IBMI_SSH_PORT=2222/);
    assert.equal(resolveProfileEnv("dev").IBMI_PASSWORD_STORE, "os");
    assert.equal(vault.get("BOB@h.example.com"), "dup-pw-4", "the last line is the one dotenv reads, so that one is migrated");
  }));

test("setup: a profile with a helper on another host drops the helper and never runs it", () =>
  isolated(async (dir) => {
    const marker = join(dirname(dir), "runs.txt");
    profile(dir, "prod", `IBMI_HOST=old.example.com\nIBMI_USER=bob\nIBMI_PASSWORD_COMMAND='${helperCommand(dirname(dir), "x", marker)}'\n`);
    // host, user kept, store chosen, Enter at the password rejected, password, policy left
    const r = await run(["prod"], ["new.example.com\r", "\r", "\r", "\r", "plainpw\r", "\r"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /IBMI_HOST old\.example\.com is replaced by new\.example\.com\n/);
    assert.doesNotMatch(r.out, /Enter keeps the current/, "neither the old helper nor the old password is offered");
    const env = resolveProfileEnv("prod");
    assert.equal(env.IBMI_PASSWORD_COMMAND, undefined, "the old host's helper is gone");
    assert.equal(env.IBMI_PASSWORD_STORE, "os");
    assert.equal(existsSync(marker), false, "the helper was not run");
    assert.deepEqual([...vault], [["BOB@new.example.com", "plainpw"]]);
  }));

test("setup: the current helper is kept only for the same host and user; the store line goes when a helper is chosen", () =>
  isolated(async (dir) => {
    const marker = join(dirname(dir), "runs.txt");
    const cmd = helperCommand(dirname(dir), "x", marker);
    profile(dir, "dev", `IBMI_HOST=h.example.com\nIBMI_USER=bob\nIBMI_PASSWORD_COMMAND='${cmd}'\nIBMI_PASSWORD_STORE=os\n`);
    const kept = await run(["dev"], ["\r", "\r", "\r", "\r"], fetchingProbe);
    assert.equal(kept.code, 0, kept.out + kept.err);
    assert.match(kept.out, /Enter keeps the current helper/);
    assert.equal(readFileSync(marker, "utf8"), "x", "the helper ran once, for the test");
    assert.equal(resolveProfileEnv("dev").IBMI_PASSWORD_COMMAND, cmd);
    assert.equal(resolveProfileEnv("dev").IBMI_PASSWORD_STORE, undefined, "one source only");
    assert.equal(vault.size, 0);
    const other = await run(["dev"], ["\r", "carol\r", "\r", "carolpw\r", "\r"]);
    assert.equal(other.code, 0, other.out + other.err);
    assert.doesNotMatch(other.out, /keeps the current helper/, "another user never keeps the helper");
    const env = resolveProfileEnv("dev");
    assert.equal(env.IBMI_PASSWORD_COMMAND, undefined);
    assert.equal(env.IBMI_PASSWORD_STORE, "os");
    assert.equal(vault.get("CAROL@h.example.com"), "carolpw");
    const back = await run(["dev"], ["other.example.com\r", "\r", cmd + "\r", "\r"]);
    assert.equal(back.code, 0, back.out + back.err);
    assert.equal(resolveProfileEnv("dev").IBMI_PASSWORD_COMMAND, cmd);
    assert.equal(resolveProfileEnv("dev").IBMI_PASSWORD_STORE, undefined);
  }));

test("setup: when the store fails nothing is written and the old file stays", () =>
  isolated(async (dir) => {
    failSet = new Error("no Secret Service on this machine");
    const r = await run(["dev"], ["h.example.com\r", "bob\r", "\r", "failpw\r", "\r"]);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /no Secret Service on this machine\).*IBMI_PASSWORD_COMMAND.*Nothing was written/);
    assert.equal(existsSync(join(dir, ".env.dev")), false);
    const old = "IBMI_HOST=h.example.com\nIBMI_USER=bob\nIBMI_PASSWORD=oldplain\n";
    profile(dir, "dev", old);
    const again = await run(["dev"], ["\r", "\r", "\r", "failpw\r", "\r"]);
    assert.equal(again.code, 2, again.out + again.err);
    assert.equal(readFileSync(join(dir, ".env.dev"), "utf8"), old, "the plain line is only removed after the store took it");
    assert.deepEqual(readdirSync(dir), [".env.dev"]);
  }));

async function cred(args: string[], keys: string[], tty = false) {
  const input = new FakeTty(keys);
  input.isTTY = tty;
  let out = "";
  let err = "";
  const code = await credentialCli(args, { input, out: (t) => void (out += t), err: (t) => void (err += t), store: fake });
  captured.push(out, err);
  assert.equal(input.raw, false, "raw mode left on");
  return { code, out, err };
}

test("credential set and delete: the fake store, the profile file untouched, nothing printed back", () =>
  isolated(async (dir) => {
    const file = "IBMI_HOST=h.example.com\nIBMI_USER=bob\nIBMI_PASSWORD_STORE=os\n";
    profile(dir, "dev", file);
    const set = await cred(["set", "dev"], ["rot-pw-1\n"]);
    assert.equal(set.code, 0, set.out + set.err);
    assert.equal(vault.get("BOB@h.example.com"), "rot-pw-1", "one stdin line");
    assert.equal(set.err, "");
    const tty = await cred(["set", "dev"], ["tty-pw-3\r"], true);
    assert.equal(tty.code, 0, tty.out + tty.err);
    assert.equal(vault.get("BOB@h.example.com"), "tty-pw-3", "hidden prompt");
    assert.match(tty.out, /password for BOB@h\.example\.com: /);
    assert.equal((await cred(["set", "dev"], ["\u0003"], true)).code, 130);
    assert.equal(vault.get("BOB@h.example.com"), "tty-pw-3", "Ctrl-C keeps the old entry");
    assert.equal((await cred(["set", "dev"], ["\n"])).code, 2, "an empty line stores nothing");
    assert.equal((await cred(["delete", "dev"], [])).code, 0);
    assert.equal(vault.size, 0);
    const none = await cred(["delete", "dev"], []);
    assert.equal(none.code, 0);
    assert.match(none.out, /no stored password/);
    assert.equal(readFileSync(join(dir, ".env.dev"), "utf8"), file, "the profile file is never changed");
  }));

test("credential: a password on argv, a bad verb, a missing profile and a store failure are exit 2; a non-store profile gets a hint", () =>
  isolated(async (dir) => {
    profile(dir, "dev", "IBMI_HOST=h.example.com\nIBMI_USER=bob\nIBMI_PASSWORD='plainpw'\n");
    for (const args of [["set", "dev", "argvpw"], ["delete", "dev", "x"], ["get", "dev"], ["set"], []]) {
      const r = await cred(args, ["argvpw\n"]);
      assert.equal(r.code, 2, args.join(" "));
      assert.match(r.err, /usage: ibmi-agent-kit credential set\|delete <profile>/);
    }
    assert.equal(vault.size, 0, "argv never reaches the store");
    const missing = await cred(["set", "nope"], ["x\n"]);
    assert.equal(missing.code, 2);
    assert.equal(vault.size, 0);
    const hint = await cred(["set", "dev"], ["rot-pw-1\n"]);
    assert.equal(hint.code, 0, hint.out + hint.err);
    assert.match(hint.err, /does not set IBMI_PASSWORD_STORE=os.*ibmi-agent-kit setup dev/);
    failSet = new Error("store is locked");
    const bad = await cred(["set", "dev"], ["failpw\n"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /store is locked/);
    assert.equal(vault.get("BOB@h.example.com"), "rot-pw-1");
  }));

test("setup: no password ever reaches stdout or stderr", () => {
  assert.ok(captured.length >= 20, "the setup tests ran first");
  for (const pw of PASSWORDS) for (const text of captured) assert.ok(!text.includes(pw), `password ${JSON.stringify(pw)} printed:\n${text}`);
});
