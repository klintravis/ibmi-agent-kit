// `setup` (first-run 1.3): a fake terminal and a fake connection, profile folders in a temp dir, so
// no real profile is read or written and no IBM i is contacted. Imported by selfcheck.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfileEnv } from "@ibmi-agent-kit/core";
import { SETUP_SQL, setupCli, type Input, type Probe } from "./setup-cli.js";

const POLICY = fileURLToPath(new URL("../../../examples/demo/policy-observe.yaml", import.meta.url));
const HOSTILE = `p#w=d s$x'y"z`;
const SKELPW = "skel-pw-9";
const PASSWORDS = [HOSTILE, "plainpw", "s3cret#2", `a\\nb'c\``, SKELPW];
const captured: string[] = [];

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
  const code = await setupCli(args, { input, out: (t) => void (out += t), err: (t) => void (err += t), connect, cwd });
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
    const r = await run(["dev"], ["box.example.com\r", "ab\u007fc\r", HOSTILE + "\r", "\r"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /OK: dev signs on as BOB to MYRDB\n$/);
    const env = resolveProfileEnv("dev");
    assert.equal(env.IBMI_HOST, "box.example.com");
    assert.equal(env.IBMI_USER, "ac", "Backspace edits");
    assert.equal(env.IBMI_PASSWORD, HOSTILE, readFileSync(join(dir, ".env.dev"), "utf8"));
    assert.equal(env.IBMI_KIT_POLICY, undefined, "Enter leaves the policy unset");
    assert.equal(seen[0].IBMI_PASSWORD, HOSTILE, "the test connects with the file's values");
    assert.deepEqual(readdirSync(dir), [".env.dev"], "no temp file left");
    if (process.platform !== "win32") assert.equal(statSync(join(dir, ".env.dev")).mode & 0o777, 0o600);
  }));

test("setup: no name writes .env; answers pasted in one chunk are taken prompt by prompt", () =>
  isolated(async (dir) => {
    const r = await run([], ["h1\ru1\rplainpw\r\r"]);
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
    const r = await run(["prod"], ["\r", "newuser\r", "\r", relative(process.cwd(), policy) + "\r"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /\[old\.example\.com\]/, "current values are offered");
    const text = readFileSync(join(dir, ".env.prod"), "utf8");
    for (const keep of ["# prod box, ask ops before changing", "IBMI_SSH_PORT=2222 # jump host", "# trailing note"]) assert.ok(text.includes(keep), text);
    const env = resolveProfileEnv("prod");
    assert.equal(env.IBMI_HOST, "old.example.com");
    assert.equal(env.IBMI_USER, "newuser", "every line setting the key is replaced:\n" + text);
    assert.equal(env.IBMI_PASSWORD, "s3cret#2");
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
    await run(["Prod"], ["h\r", "u\r", "plainpw\r", "\r"]);
    assert.equal(readFileSync(join(dir, ".env.prod"), "utf8"), "IBMI_USER=keep\n", "another server's file was changed");
    rmSync(dir, { recursive: true, force: true });
    const r = await run(["dev"], ["h\r", "u\r", "plainpw\r", "\r"], okProbe, false);
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
    const q = await run(["dev"], ["h\r", "u\r", `a\\nb'c\`` + "\r", "\r"]);
    assert.equal(q.code, 2);
    assert.match(q.err, /IBMI_PASSWORD cannot be written safely/);
    assert.equal(existsSync(join(dir, ".env.dev")), false);
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
    const r = await run(["dev"], ["h\r", "u\r", HOSTILE + "\r", "\r"], failing);
    assert.equal(r.code, 1);
    assert.match(r.out, /\nfailed: login failed for .*\*\*\*/);
    assert.ok(closed, "the connection is closed");
    assert.ok(existsSync(join(dir, ".env.dev")));
    const before = readFileSync(join(dir, ".env.dev"), "utf8");
    const p = await run(["dev"], ["\r", "\r", "\r", join(dir, "missing.yaml") + "\r"]);
    assert.equal(p.code, 2);
    assert.match(p.err, /IBMI_KIT_POLICY .*policy file not found.*Nothing was written/);
    assert.equal(readFileSync(join(dir, ".env.dev"), "utf8"), before, "a bad policy answer is not saved");
    assert.equal(resolveProfileEnv("dev").IBMI_KIT_POLICY, undefined);
  }));

test("setup: a quoted policy path and a ~ path are cleaned before they are saved", () =>
  isolated(async (dir) => {
    const home = process.env.HOME!;
    copyFileSync(POLICY, join(home, "pol.yaml"));
    const q = await run(["dev"], ["h\r", "u\r", "plainpw\r", `"${join(home, "pol.yaml")}"\r`]);
    assert.equal(q.code, 0, q.out + q.err);
    assert.equal(resolveProfileEnv("dev").IBMI_KIT_POLICY, join(home, "pol.yaml"));
    const t = await run(["dev"], ["\r", "\r", "\r", "~/pol.yaml\r"]);
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
    const dev = ["# skeleton", "IBMI_HOST=kdev01.example.com", "IBMI_USER=YOUR_USER", "IBMI_SQL_TRANSPORT=mapepire", "IBMI_PARTITION=dev", "IBMI_KIT_POLICY=/admin/only/policy.yaml", `IBMI_PASSWORD=${SKELPW}`, ""].join("\n");
    const repo = companyRepo(dirname(dir), { ".env.dev": dev, ".env.prod": skel("prod"), ".env.example": skel("example") });
    const before = snapshot(repo);
    seen.length = 0;
    const r = await run(["dev"], ["bob\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(r.out.includes(`company config repo: ${repo}`), r.out);
    assert.match(r.out, /\nIBM i user: bob/, "the placeholder user is not offered");
    assert.doesNotMatch(r.out, /YOUR_USER|IBM i host|policy file/, "host and policy are not asked");
    assert.match(r.err, /\.env\.dev holds a password\. It is ignored/);
    assert.ok(r.out.includes(`set it to ${KIT}`), r.out);
    const env = resolveProfileEnv("dev");
    assert.equal(env.IBMI_HOST, "kdev01.example.com");
    assert.equal(env.IBMI_PARTITION, "dev");
    assert.equal(env.IBMI_SQL_TRANSPORT, "mapepire", "a non-credential skeleton key is copied");
    assert.equal(env.IBMI_USER, "bob");
    assert.equal(env.IBMI_PASSWORD, "plainpw", "the skeleton's password is never written");
    assert.equal(env.IBMI_KIT_POLICY, join(repo, "policy.yaml"));
    assert.ok(isAbsolute(env.IBMI_KIT_POLICY));
    assert.equal(seen[0].IBMI_SQL_TRANSPORT, "mapepire", "the test connects with the copied transport");
    assert.ok(!readFileSync(join(dir, ".env.dev"), "utf8").includes(SKELPW));
    const after = snapshot(repo);
    assert.equal(after, before, "a repo file changed");
    assert.ok(!after.includes("plainpw"));

    // A second run offers the user, keeps the password, and replaces another policy path.
    writeFileSync(join(dir, ".env.dev"), readFileSync(join(dir, ".env.dev"), "utf8") + "IBMI_KIT_POLICY=/elsewhere/policy.yaml\n");
    const again = await run(["dev"], ["\r", "\r"], okProbe, true, repo);
    assert.equal(again.code, 0, again.out + again.err);
    assert.match(again.out, /\[bob\]/);
    assert.ok(again.out.includes(`IBMI_KIT_POLICY /elsewhere/policy.yaml is replaced by ${join(repo, "policy.yaml")}`), again.out);
    assert.equal(resolveProfileEnv("dev").IBMI_KIT_POLICY, join(repo, "policy.yaml"));
    assert.equal(resolveProfileEnv("dev").IBMI_PASSWORD, "plainpw");
    assert.equal(snapshot(repo), before);
  }));

test("setup in a company repo: several partitions are offered, one is taken as is", () =>
  isolated(async (dir) => {
    const repo = companyRepo(dirname(dir), { ".env.dev": skel("dev"), ".env.prod": skel("prod"), ".env.example": skel("example"), ".env.prod.bak": skel("old") });
    const m = await run([], ["x\r", "2\r", "bob\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(m.code, 0, m.out + m.err);
    assert.match(m.out, / {2}1\. dev\n {2}2\. prod\npartition \(number or name\): x\npartition/, "listed by the loader's rules; a wrong answer asks again");
    assert.deepEqual(readdirSync(dir), [".env.prod"]);
    assert.equal(resolveProfileEnv("prod").IBMI_HOST, "kprod.example.com");
    const n = await run([], ["dev\r", "bob\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(n.code, 0, n.out + n.err);
    assert.equal(resolveProfileEnv("dev").IBMI_PARTITION, "dev", "answered by name");
    rmSync(join(repo, "profiles", ".env.prod"));
    rmSync(join(dir, ".env.dev"));
    const s = await run([], ["bob\r", "plainpw\r"], okProbe, true, repo);
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
      const i = await run(["dev"], ["bob\r", "plainpw\r"], okProbe, true, repo);
      assert.equal(i.code, 2, inside);
      assert.match(i.err, /inside the company config repo .*Nothing was written/);
      assert.equal(i.out, "", "refused before the first prompt");
      assert.equal(snapshot(repo), before);
    }
    process.env.IBMI_KIT_CONFIG_DIR = dir;
    writeFileSync(join(repo, "profiles", ".env.qa"), "IBMI_PARTITION=qa\n");
    const h = await run(["qa"], [], okProbe, true, repo);
    assert.equal(h.code, 2);
    assert.match(h.err, /\.env\.qa sets no IBMI_HOST\. Nothing was written/);
    writeFileSync(join(repo, "policy.yaml"), "version: [not a policy\n");
    const p = await run(["dev"], ["bob\r", "plainpw\r"], okProbe, true, repo);
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
    const a = await run([], ["bob\r", "plainpw\r"], okProbe, true, repo);
    assert.equal(a.code, 0, a.out + a.err);
    assert.doesNotMatch(a.out, /IBMI_KIT_HOME/);
    writeFileSync(join(repo, ".mcp.json"), MCP_HOME);
    process.env.IBMI_KIT_HOME = KIT;
    const b = await run([], ["\r", "\r"], okProbe, true, repo);
    assert.equal(b.code, 0, b.out + b.err);
    assert.doesNotMatch(b.out, /IBMI_KIT_HOME/);
    rmSync(join(repo, "profiles"), { recursive: true });
    const c = await run(["other"], ["h\r", "u\r", "plainpw\r", "\r"], okProbe, true, repo);
    assert.equal(c.code, 0, c.out + c.err);
    assert.match(c.out, /IBM i host: h/);
    assert.doesNotMatch(c.out, /company config repo/);
  }));

test("setup: no password ever reaches stdout or stderr", () => {
  assert.ok(captured.length >= 20, "the setup tests ran first");
  for (const pw of PASSWORDS) for (const text of captured) assert.ok(!text.includes(pw), `password ${JSON.stringify(pw)} printed:\n${text}`);
});
