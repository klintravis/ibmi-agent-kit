// The sign-on page server (signon-page 3.x): real loopback HTTP, a fake credential store, profile folders
// in a temp dir. No real OS store, no profile of this machine, no IBM i. Imported by selfcheck.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProfile, resetSignOnState, resolveProfileEnv, setCredentialStore, setSignOnPage, signOnOnce, signOnPageInstalled, type CredentialStore, type SignOnProfile } from "@ibmi-agent-kit/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { builtinPolicy } from "@ibmi-agent-kit/guard";
import { MapepireBackend } from "@ibmi-agent-kit/source/tools";
import { createServer, shutdownAll } from "./server.js";
import { ELICIT_WINDOW_MS } from "./signon-offer.js";
import { PAGE_TTL_MS, SignOnPages, type Page } from "./signon-page.js";

const POLICY = fileURLToPath(new URL("../../../examples/demo/policy-observe.yaml", import.meta.url));
const MARKER = "marker-pw-7Qz#9";
const BOB: SignOnProfile = { host: "box.example.com", user: "bob", passwordStore: "os" };

const vault = new Map<string, string>();
let sets = 0;
let failSet: Error | undefined;
const fake: CredentialStore = {
  get: async (a) => vault.get(a) ?? null,
  set: async (a, s) => {
    if (failSet) throw failSet;
    sets++;
    vault.set(a, s);
  },
  delete: async (a) => vault.delete(a),
};

let clock = 1_000_000;
const stderrText: string[] = [];

async function isolated(body: (root: string, pages: SignOnPages) => Promise<void>, cwd?: (root: string) => string) {
  await sandbox(async (root) => {
    const pages = new SignOnPages({ now: () => clock, cwd: () => (cwd ? cwd(root) : join(root, "plain")) });
    try {
      await body(root, pages);
    } finally {
      pages.close();
    }
  });
}

async function sandbox(body: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "kit-signon-"));
  const saved = { ...process.env };
  const write = process.stderr.write.bind(process.stderr);
  vault.clear();
  sets = 0;
  failSet = undefined;
  clock = 1_000_000;
  stderrText.length = 0;
  setCredentialStore(fake);
  resetSignOnState();
  for (const k of Object.keys(process.env)) if (k.startsWith("IBMI_")) delete process.env[k];
  Object.assign(process.env, { IBMI_KIT_CONFIG_DIR: join(root, "config"), HOME: root, USERPROFILE: root });
  process.stderr.write = ((c: unknown, ...rest: unknown[]) => (stderrText.push(String(c)), (write as (...a: unknown[]) => boolean)(c, ...rest))) as typeof process.stderr.write;
  mkdirSync(join(root, "plain"));
  try {
    await body(root);
  } finally {
    setSignOnPage();
    process.stderr.write = write;
    setCredentialStore();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}
function call(url: string, o: { method?: string; host?: string; headers?: Record<string, string>; body?: string; path?: string; chunked?: boolean } = {}): Promise<Res> {
  const u = new URL(url);
  return new Promise((ok, fail) => {
    const headers: Record<string, string> = { ...(o.host ? { host: o.host } : {}), ...o.headers };
    if (o.body !== undefined) {
      headers["content-type"] ??= "application/x-www-form-urlencoded";
      if (!o.chunked) headers["content-length"] = String(Buffer.byteLength(o.body));
    }
    const r = http.request({ host: "127.0.0.1", port: u.port, path: o.path ?? "/" + u.search, method: o.method ?? "GET", headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (c) => (text += c)).on("end", () => ok({ status: res.statusCode!, headers: res.headers, text }));
    });
    r.on("error", fail);
    r.end(o.body);
  });
}
const tokenOf = (p: Page) => new URL(p.url).searchParams.get("t")!;
const post = (p: Page, fields: Record<string, string>, o: Parameters<typeof call>[1] = {}) =>
  // A browser form post carries Origin; the default does too, so success rows run as a browser would.
  call(p.url, { method: "POST", body: new URLSearchParams(fields).toString(), path: "/", ...o, headers: { origin: `http://127.0.0.1:${new URL(p.url).port}`, ...o.headers } });
const submit = (p: Page, password = MARKER, extra: Record<string, string> = {}) => post(p, { t: tokenOf(p), password, ...extra });

function everyHeader(r: Res, what: string) {
  assert.equal(r.headers["cache-control"], "no-store", what);
  assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/, what);
  assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/, what);
  assert.equal(r.headers["referrer-policy"], "same-origin", what);
}
const offer = async (pages: SignOnPages, why: "missing" | "rejected" = "missing", p = BOB) => {
  const page = await pages.offer(p, why);
  assert.ok(page, "a page was offered");
  return page;
};

test("signon page: a GET shows the form and keeps the token, one accepted POST stores and uses it up", () =>
  isolated(async (_root, pages) => {
    const page = await offer(pages);
    assert.match(page.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
    assert.equal(new URL(page.url).search.length, 3 + 32, "the link holds the token and nothing else");
    for (let i = 0; i < 2; i++) {
      const g = await call(page.url);
      assert.equal(g.status, 200);
      assert.match(g.text, /type="password"/);
      assert.match(g.text, /bob on box\.example\.com/);
      assert.ok(!g.text.includes(MARKER));
    }
    assert.equal(sets, 0, "a GET stores nothing");
    const r = await submit(page);
    assert.equal(r.status, 200, r.text);
    assert.equal(vault.get("BOB@box.example.com"), MARKER);
    assert.equal(sets, 1);
    const again = await submit(page, "second-" + MARKER);
    assert.equal(again.status, 403);
    assert.equal((await call(page.url)).status, 403, "a used link shows no form");
    assert.equal(sets, 1, "a second POST writes nothing");
    assert.equal(vault.get("BOB@box.example.com"), MARKER);
    const next = await offer(pages);
    assert.notEqual(tokenOf(next), tokenOf(page), "a new offer gets a new token");
    assert.equal((await submit(next, "new-pw")).status, 200);
  }));

test("signon page: two racing POSTs have one winner; an empty password keeps the token", () =>
  isolated(async (_root, pages) => {
    const page = await offer(pages);
    const blank = await submit(page, "");
    assert.equal(blank.status, 400);
    assert.match(blank.text, /Enter the password/);
    assert.ok(!blank.text.includes(MARKER));
    const both = await Promise.all([submit(page, "one-pw"), submit(page, "two-pw")]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 403]);
    assert.equal(sets, 1);
  }));

test("signon page: an expired token is refused, and the next offer is a new page", () =>
  isolated(async (_root, pages) => {
    const page = await offer(pages);
    clock += PAGE_TTL_MS - 1;
    assert.equal((await call(page.url)).status, 200, "still valid just before the end");
    clock += 1;
    assert.equal((await call(page.url)).status, 403);
    assert.equal((await submit(page)).status, 403);
    assert.equal(sets, 0);
    const next = await offer(pages);
    assert.notEqual(tokenOf(next), tokenOf(page));
    assert.equal((await submit(next)).status, 200);
  }));

test("signon page: one pending page per account, shared by concurrent offers", () =>
  isolated(async (_root, pages) => {
    const [a, b] = await Promise.all([pages.offer(BOB, "missing"), pages.offer(BOB, "missing")]);
    assert.equal(a, b);
    const other = await pages.offer({ ...BOB, user: "carol" }, "missing");
    assert.notEqual(other, a);
    assert.equal(new URL(other!.url).port, new URL(a!.url).port, "one listener serves both");
  }));

test("signon page: refusals - Host, token, Origin, query string, size - all locked down", () =>
  isolated(async (_root, pages) => {
    const page = await offer(pages);
    const t = tokenOf(page);
    const refused: [string, Res][] = [
      ["wrong Host on GET", await call(page.url, { host: "evil.example" })],
      ["wrong Host on POST", await post(page, { t, password: MARKER }, { host: "evil.example" })],
      ["Host with a loopback prefix", await call(page.url, { host: "127.0.0.1.evil.example" })],
      ["no token on GET", await call(page.url, { path: "/" })],
      ["wrong token on GET", await call(page.url, { path: "/?t=" + "0".repeat(32) })],
      ["token only in the query string", await call(page.url, { method: "POST", path: "/?t=" + t, body: "password=" + MARKER })],
      ["foreign Origin", await post(page, { t, password: MARKER }, { headers: { origin: "http://evil.example" } })],
      ["null Origin", await post(page, { t, password: MARKER }, { headers: { origin: "null" } })],
      ["wrong token in the body", await post(page, { t: "f".repeat(32), password: MARKER })],
      ["no content type", await post(page, { t, password: MARKER }, { headers: { "content-type": "text/plain" } })],
      ["oversized body", await post(page, { t, password: "x".repeat(5000) })],
      ["oversized chunked body", await post(page, { t, password: "x".repeat(9000) }, { chunked: true })],
      ["other path", await call(page.url, { path: "/other?t=" + t })],
      ["PUT", await call(page.url, { method: "PUT", path: "/", body: "x" })],
    ];
    for (const [what, r] of refused) {
      assert.ok(r.status >= 400, `${what}: ${r.status}`);
      everyHeader(r, what);
      assert.ok(!r.text.includes(MARKER), what);
    }
    assert.equal(refused.find(([w]) => w === "oversized body")![1].status, 413);
    assert.equal(refused.find(([w]) => w === "oversized chunked body")![1].status, 413);
    assert.equal(refused.find(([w]) => w === "foreign Origin")![1].status, 403);
    assert.equal(sets, 0, "no refused request wrote the store");
    assert.equal((await submit(page)).status, 200, "the token survived every refusal");
  }));

test("signon page: refusals leave the form usable, and every response carries the headers", () =>
  isolated(async (_root, pages) => {
    const page = await offer(pages);
    const t = tokenOf(page);
    const bads = [
      await post(page, { t, password: MARKER }, { headers: { origin: "http://evil.example" } }),
      await call(page.url, { method: "POST", path: "/?t=" + t, body: "password=" + MARKER }),
      await post(page, { t, password: "x".repeat(5000) }),
      await call(page.url, { host: "evil.example" }),
    ];
    for (const r of bads) {
      assert.ok(r.status >= 400);
      everyHeader(r, String(r.status));
    }
    assert.equal(sets, 0, "no refused request wrote the store");
    const ok = await call(page.url);
    assert.equal(ok.status, 200);
    everyHeader(ok, "GET");
    assert.equal((await submit(page)).status, 200, "the token survived every refusal");
    const done = await submit(page);
    everyHeader(done, "used token");
  }));

test("signon page: a GET ignores values in its query string", () =>
  isolated(async (_root, pages) => {
    const page = await offer(pages);
    const g = await call(page.url, { path: "/?t=" + tokenOf(page) + "&host=evil.example&user=mallory&password=" + MARKER });
    assert.equal(g.status, 200);
    assert.ok(!/evil\.example|mallory/.test(g.text) && !g.text.includes(MARKER));
    assert.match(g.text, /bob on box\.example\.com/);
  }));

test("signon page: the password is in no page response and no stderr, on the accepted, failed and rejected paths", () =>
  isolated(async (_root, pages) => {
    const seen: string[] = [];
    const page = await offer(pages);
    seen.push((await call(page.url)).text);
    // A wrong-field submission and a store failure (whose text may echo the secret) both stay silent about it.
    failSet = new Error(`keyring said no to ${MARKER}`);
    const failed = await submit(page);
    seen.push(failed.text);
    assert.equal(failed.status, 500);
    assert.match(failed.text, /Not saved/);
    assert.equal(vault.size, 0);
    failSet = undefined;
    assert.equal((await submit(page)).status, 403, "a store failure uses the link up");
    const next = await offer(pages, "rejected");
    seen.push((await call(next.url)).text, (await submit(next)).text);
    const refused = await post(next, { t: tokenOf(next), password: MARKER });
    seen.push(refused.text);
    for (const t of seen) assert.ok(!t.includes(MARKER) && !t.includes(encodeURIComponent(MARKER)));
    assert.ok(!stderrText.join("").includes(MARKER), "nothing wrote the password to stderr");
  }));

test("signon page: re-offer limit - a submitted rejected-page counts, an expired or first-time one does not", () =>
  isolated(async (_root, pages) => {
    // Stale entry rejected -> page -> submitted -> rejected again -> no page.
    const p1 = await offer(pages, "rejected");
    assert.equal((await submit(p1, "pw-1")).status, 200);
    assert.equal(await pages.offer(BOB, "rejected"), undefined);
    assert.equal(await pages.offer(BOB, "rejected"), undefined);
    // A missing entry can still be offered (a different cause), and a fresh process is a new SignOnPages.
    assert.ok(await pages.offer(BOB, "missing"));
    // First time: missing -> page -> submitted; rejected -> page -> submitted; rejected -> none.
    const carol = { ...BOB, user: "carol" };
    const m = await offer(pages, "missing", carol);
    assert.equal((await submit(m, "pw-2")).status, 200);
    const r = await offer(pages, "rejected", carol);
    assert.equal((await submit(r, "pw-3")).status, 200);
    assert.equal(await pages.offer(carol, "rejected"), undefined);
    // An expired re-offer costs nothing.
    const dave = { ...BOB, user: "dave" };
    const e1 = await offer(pages, "rejected", dave);
    clock += PAGE_TTL_MS;
    const e2 = await offer(pages, "rejected", dave);
    assert.notEqual(tokenOf(e2), tokenOf(e1));
    assert.equal((await submit(e2, "pw-4")).status, 200);
    assert.equal(await pages.offer(dave, "rejected"), undefined);
    // A store failure sent nothing to the box, so it does not count either.
    const erin = { ...BOB, user: "erin" };
    failSet = new Error("down");
    assert.equal((await submit(await offer(pages, "rejected", erin), "pw-5")).status, 500);
    failSet = undefined;
    assert.ok(await pages.offer(erin, "rejected"));
  }));

test("signon page: a reused page takes the rejected cause, so its wrong submission counts and no third page follows", () =>
  isolated(async (_root, pages) => {
    const p1 = await offer(pages, "missing");
    assert.equal(await offer(pages, "rejected"), p1, "the live page is reused");
    assert.equal((await submit(p1, "wrong")).status, 200);
    assert.equal(await pages.offer(BOB, "rejected"), undefined);
  }));

test("signon page: a post with the page's own Origin saves, for an account page and a first-profile page", () =>
  isolated(async (root, pages) => {
    const page = await offer(pages);
    assert.equal((await submit(page)).status, 200); // post() sends Origin http://127.0.0.1:<port>
    assert.equal(vault.get("BOB@box.example.com"), MARKER);
    const f = await first(pages);
    const r = await post(f, { t: tokenOf(f), host: "box.example.com", user: "carol", password: "pw-c" });
    assert.equal(r.status, 200, r.text);
    assert.ok(existsSync(join(dirOf(root), ".env")));
  }));

// ---- first profile (5.7) ----

const fields = (page: Page, f: Record<string, string>) => post(page, { t: tokenOf(page), ...f });
const first = async (pages: SignOnPages) => {
  const r = await pages.firstProfile();
  assert.ok(r && "page" in r, JSON.stringify(r));
  return r.page;
};
const dirOf = (root: string) => join(root, "config");

test("signon first profile: no repo - a typed host writes .env with the store setting and no password", () =>
  isolated(async (root, pages) => {
    const page = await first(pages);
    const g = await call(page.url);
    assert.match(g.text, /name="host"/);
    const r = await fields(page, { host: "box.example.com", user: "bob", password: MARKER });
    assert.equal(r.status, 200, r.text);
    const text = readFileSync(join(dirOf(root), ".env"), "utf8");
    assert.ok(!text.includes(MARKER) && !/IBMI_PASSWORD=/.test(text), text);
    const env = parseProfile(text);
    assert.equal(env.IBMI_HOST, "box.example.com");
    assert.equal(env.IBMI_USER, "bob");
    assert.equal(env.IBMI_PASSWORD_STORE, "os");
    assert.equal(vault.get("BOB@box.example.com"), MARKER);
    assert.equal(resolveProfileEnv().IBMI_PASSWORD_STORE, "os");
    assert.equal(await pages.firstProfile(), undefined, "a profile exists now: nothing to offer");
    assert.equal((await fields(page, { host: "x.example.com", user: "bob", password: "again" })).status, 403);
    assert.ok(!stderrText.join("").includes(MARKER));
  }));

test("signon first profile: bad input re-renders without the password and keeps the token", () =>
  isolated(async (root, pages) => {
    const page = await first(pages);
    for (const f of [{ host: "", user: "bob", password: MARKER }, { host: "h.example.com", user: "", password: MARKER }, { host: "h.example.com", user: "bob", password: "" }, { host: "h\nIBMI_PORT=1", user: "bob", password: MARKER }]) {
      const r = await fields(page, f);
      assert.equal(r.status, 400, r.text);
      assert.ok(!r.text.includes(MARKER));
    }
    assert.equal(existsSync(dirOf(root)), false);
    assert.equal(vault.size, 0);
    assert.equal((await fields(page, { host: "h.example.com", user: "bob", password: MARKER })).status, 200);
  }));

test("signon first profile: HTML in a value is escaped, and the link holds none of it", () =>
  isolated(async (_root, pages) => {
    const page = await first(pages);
    assert.ok(!/host|user|default/i.test(page.url.replace("127.0.0.1", "")), page.url);
    const r = await fields(page, { host: `<script>alert(1)</script>`, user: `"><img src=x onerror=alert(2)>`, password: "" });
    assert.equal(r.status, 400);
    assert.ok(!r.text.includes("<script>alert") && !r.text.includes("<img src=x"), r.text);
    assert.match(r.text, /&#60;script&#62;/);
  }));

test("signon first profile: a store failure writes no file and uses the link up", () =>
  isolated(async (root, pages) => {
    const page = await first(pages);
    failSet = new Error(`no secret service for ${MARKER}`);
    const r = await fields(page, { host: "box.example.com", user: "bob", password: MARKER });
    assert.equal(r.status, 500);
    assert.match(r.text, /Nothing was written/);
    assert.ok(!r.text.includes(MARKER));
    assert.equal(existsSync(dirOf(root)) ? readdirSync(dirOf(root)).length : 0, 0, "no file, no temp file");
    assert.equal(vault.size, 0);
    assert.equal((await fields(page, { host: "box.example.com", user: "bob", password: MARKER })).status, 403);
    failSet = undefined;
    assert.ok(await first(pages), "the next call offers a new page");
  }));

test("signon first profile: a profile folder in a git work tree is refused, nothing written", () =>
  isolated(async (root, pages) => {
    const wt = join(root, "wt");
    mkdirSync(join(wt, ".git"), { recursive: true });
    process.env.IBMI_KIT_CONFIG_DIR = join(wt, "profiles");
    const r = await pages.firstProfile();
    assert.ok(r && "refused" in r && /git work tree/.test(r.refused), JSON.stringify(r));
    assert.equal(existsSync(join(wt, "profiles")), false);
    // The tree appears after the offer: the submit refuses too.
    process.env.IBMI_KIT_CONFIG_DIR = join(root, "config");
    const page = await first(pages);
    process.env.IBMI_KIT_CONFIG_DIR = join(wt, "profiles");
    const s = await fields(page, { host: "box.example.com", user: "bob", password: MARKER });
    assert.equal(s.status, 403);
    assert.match(s.text, /git work tree/);
    assert.equal(existsSync(join(wt, "profiles")), false);
    assert.equal(vault.size, 0);
  }));

test("signon first profile: a profile that appears after the offer is not overwritten; with profiles present nothing is offered", () =>
  isolated(async (root, pages) => {
    const page = await first(pages);
    mkdirSync(dirOf(root), { recursive: true });
    writeFileSync(join(dirOf(root), ".env"), "IBMI_HOST=mine.example.com\nIBMI_USER=me\n");
    const r = await fields(page, { host: "box.example.com", user: "bob", password: MARKER });
    assert.equal(r.status, 403);
    assert.equal(readFileSync(join(dirOf(root), ".env"), "utf8"), "IBMI_HOST=mine.example.com\nIBMI_USER=me\n");
    assert.equal(vault.size, 0);
    assert.equal(await pages.firstProfile(), undefined, "a typo with profiles present stays the existing error");
  }));

function repoWith(root: string, skeletons: Record<string, string>) {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "profiles"), { recursive: true });
  copyFileSync(POLICY, join(repo, "policy.yaml"));
  for (const [f, text] of Object.entries(skeletons)) writeFileSync(join(repo, "profiles", f), text);
  return repo;
}
const skel = (p: string, extra = "") => `# skeleton\nIBMI_HOST=k${p}.example.com\nIBMI_USER=YOUR_USER\nIBMI_PARTITION=${p}\n${extra}`;

test("signon first profile: one skeleton - its settings and the repo's policy, no skeleton password or helper copied", () =>
  isolated(
    async (root, pages) => {
      repoWith(root, { ".env.dev": skel("dev", `IBMI_PASSWORD=skel-pw\nIBMI_PASSWORD_COMMAND=node evil.js\nIBMI_SSH_PORT=2222\n`) });
      const page = await first(pages);
      const g = await call(page.url);
      assert.match(g.text, /Partition dev on host kdev\.example\.com/);
      assert.ok(!/name="host"/.test(g.text), "the host comes from the skeleton");
      const r = await fields(page, { host: "attacker.example.com", user: "bob", password: MARKER });
      assert.equal(r.status, 200, r.text);
      assert.match(r.text, /holds a password/);
      assert.match(r.text, /IBMI_PASSWORD_COMMAND/);
      const text = readFileSync(join(dirOf(root), ".env.dev"), "utf8");
      const env = parseProfile(text);
      assert.equal(env.IBMI_HOST, "kdev.example.com", "a posted host is ignored in a repo");
      assert.equal(env.IBMI_SSH_PORT, "2222");
      assert.equal(env.IBMI_PARTITION, "dev");
      assert.equal(env.IBMI_KIT_POLICY, join(root, "repo", "policy.yaml"));
      assert.equal(env.IBMI_PASSWORD_STORE, "os");
      assert.ok(!/skel-pw|evil\.js|IBMI_PASSWORD=|IBMI_PASSWORD_COMMAND/.test(text), text);
      assert.equal(vault.get("BOB@kdev.example.com"), MARKER);
    },
    (root) => join(root, "repo"),
  ));

test("signon first profile: several skeletons - a partition is chosen from the list, a stranger is refused", () =>
  isolated(
    async (root, pages) => {
      repoWith(root, { ".env.dev": skel("dev"), ".env.prod": skel("prod") });
      const page = await first(pages);
      const g = await call(page.url);
      assert.match(g.text, /<select name="partition"/);
      assert.match(g.text, /prod \(kprod\.example\.com\)/);
      assert.equal((await fields(page, { user: "bob", password: MARKER })).status, 400);
      assert.equal((await fields(page, { partition: "../x", user: "bob", password: MARKER })).status, 400);
      assert.equal(existsSync(dirOf(root)), false);
      assert.equal((await fields(page, { partition: "prod", user: "bob", password: MARKER })).status, 200);
      assert.equal(parseProfile(readFileSync(join(dirOf(root), ".env.prod"), "utf8")).IBMI_HOST, "kprod.example.com");
      assert.equal(existsSync(join(dirOf(root), ".env.dev")), false);
    },
    (root) => join(root, "repo"),
  ));

test("signon first profile: a skeleton with no host, no skeleton at all, a bad policy and a line break are refused", () => {
  const bad = (name: string, build: (root: string) => void, want: RegExp) =>
    isolated(
      async (root, pages) => {
        build(root);
        const r = await pages.firstProfile();
        if (r && "refused" in r) return assert.match(r.refused, want, name);
        assert.ok(r && "page" in r, name);
        const s = await fields(r.page, { user: "bob", password: MARKER });
        assert.ok(s.status >= 400 && want.test(s.text), name + ": " + s.text);
        assert.ok(!s.text.includes(MARKER));
        assert.equal(existsSync(dirOf(root)) ? readdirSync(dirOf(root)).length : 0, 0, name);
        assert.equal(vault.size, 0, name);
      },
      (root) => join(root, "repo"),
    );
  return (async () => {
    // One after the other: each run owns process.env.
    await bad("no host", (r) => repoWith(r, { ".env.dev": "IBMI_PARTITION=dev\n" }), /sets no IBMI_HOST/);
    await bad("no skeleton", (r) => repoWith(r, {}), /no profile skeleton/);
    await bad("bad policy", (r) => (repoWith(r, { ".env.dev": skel("dev") }), writeFileSync(join(r, "repo", "policy.yaml"), "not: [valid")), /IBMI_KIT_POLICY/);
  })();
});

test("signon first profile: the profile folder inside the company repo is refused", () =>
  isolated(
    async (root, pages) => {
      repoWith(root, { ".env.dev": skel("dev") });
      process.env.IBMI_KIT_CONFIG_DIR = join(root, "repo", "out");
      const r = await pages.firstProfile();
      assert.ok(r && "refused" in r && /company config repo/.test(r.refused), JSON.stringify(r));
      assert.equal(existsSync(join(root, "repo", "out")), false);
    },
    (root) => join(root, "repo"),
  ));

// ---- delivery and retry through a real MCP client over createServer (4.1 to 4.3, 5.3 to 5.6, 5.8) ----

type Answer = "accept" | "decline" | "error" | "never";
const LINK = /http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}/;

// A kit whose box connects through the real signOnOnce around a counting `send`, a fake MCP client that
// answers URL elicitation as told, and the sign-on hook installed as serve() would.
async function wired(root: string, o: { url?: Answer; hook?: boolean; profile?: Record<string, unknown> } = {}) {
  resetSignOnState();
  const localDir = join(root, "local");
  mkdirSync(localDir, { recursive: true });
  const profile = { host: "box.example.com", user: "bob", passwordStore: "os", sshPort: 22, sqlTransport: "ssh", mapepirePort: 8076, sourceFileCcsid: 37, localDir, readOnly: false, blockedTables: [], blockedCl: [], ...o.profile };
  const wire: string[] = []; // every password that reached the box
  const st = { reject: false, up: false };
  const ensure = async () => {
    if (st.up) return;
    await signOnOnce(
      profile as SignOnProfile,
      async (pw) => {
        wire.push(pw);
        if (st.reject) throw new Error(`client-authentication: all configured authentication methods failed (${pw})`);
        st.up = true;
      },
      (e) => /authentication/.test(String((e as Error).message)),
    );
  };
  const transport = {
    connect: ensure,
    close: async () => {},
    query: async () => (await ensure(), { rows: [], columns: [], truncated: false }),
    execute: async () => (await ensure(), { rowsAffected: 0, messages: [] }),
    cl: async () => (await ensure(), { ok: true, messages: [] }),
  };
  const be = new MapepireBackend(profile as ConstructorParameters<typeof MapepireBackend>[0], transport as unknown as ConstructorParameters<typeof MapepireBackend>[1]);
  const runs = join(root, "runs");
  const kit = createServer({ policy: builtinPolicy(), conn: () => be, sourceBackend: () => be, profileEnv: () => ({}), runLogDir: runs, confirmTimeoutMs: 5000, sqlTimeLimitMs: 5000, notice: (m) => void process.stderr.write(m + "\n"), signOn: { now: () => clock, cwd: () => join(root, "plain") } });
  if (o.hook !== false) setSignOnPage(kit.signOn.hook);
  const requests: Record<string, any>[] = []; // every elicitation the client was sent
  const notes: string[] = []; // every notification the client got
  const client = new Client({ name: "selfcheck", version: "0" }, o.url ? { capabilities: { elicitation: { form: {}, url: {} } } } : undefined);
  if (o.url) {
    client.setRequestHandler(ElicitRequestSchema, async (req): Promise<ElicitResult> => {
      requests.push(req.params);
      if (o.url === "never") return new Promise<ElicitResult>(() => {});
      if (o.url === "error") throw new Error("the client refuses");
      return { action: o.url === "decline" ? "decline" : "accept" };
    });
  }
  client.fallbackNotificationHandler = async (n) => void notes.push(JSON.stringify(n));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([kit.mcp.connect(b), client.connect(a)]);
  const results: string[] = []; // every tool result text
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0].text;
    results.push(text);
    return { error: r.isError === true, text };
  };
  return {
    kit, client, wire, st, requests, notes, results, tool,
    run: () => tool("run_sql", { statement: "select 1 from BOB.T" }),
    settle: () => new Promise((r) => setTimeout(r, 40)), // lets a fired, unawaited elicitation reach the client
    url: (i = -1) => String(requests.at(i)!.url),
    logs: () => (existsSync(runs) ? readdirSync(runs).map((f) => readFileSync(join(runs, f), "utf8")).join("\n") : ""),
    close: async () => {
      await client.close();
      await shutdownAll(kit.engines);
    },
  };
}
const store = (pw: string) => vault.set("BOB@box.example.com", pw);

test("signon delivery: a client without elicitation.url gets the link at once and no request; its submit sends no completion", () =>
  sandbox(async (root) => {
    const k = await wired(root);
    try {
      const r = await k.run();
      assert.ok(r.error);
      const link = r.text.match(LINK)?.[0];
      assert.ok(link, r.text);
      assert.match(r.text, /Give this link to the user/);
      assert.match(r.text, /ibmi-agent-kit setup/);
      const u = new URL(link);
      assert.equal(u.pathname + u.search.replace(/[0-9a-f]{32}/, "T"), "/?t=T");
      assert.ok(!/bob|box\.example/i.test(link), "the link holds no user, host or profile name");
      assert.equal(k.requests.length, 0, "no elicitation request");
      assert.equal((await submit({ url: link } as Page, "pw-link")).status, 200);
      await k.settle();
      assert.ok(!k.notes.some((n) => n.includes("elicitation/complete")), "a link-only page sends no completion");
      assert.equal(k.wire.length, 0, "a submission sends nothing to the box");
    } finally {
      await k.close();
    }
  }));

test("signon delivery: a URL-capable client gets one URL request and no link; the submit completes it; the next call sends once", () =>
  sandbox(async (root) => {
    const k = await wired(root, { url: "accept" });
    try {
      const r = await k.run();
      assert.ok(r.error);
      assert.ok(!LINK.test(r.text) && !/127\.0\.0\.1/.test(r.text), "no link in the first error: " + r.text);
      assert.match(r.text, /prompt for it was offered/);
      await k.settle();
      assert.equal(k.requests.length, 1);
      const req = k.requests[0];
      assert.equal(req.mode, "url", "form mode is never requested");
      assert.match(req.url, LINK);
      assert.ok(req.elicitationId && !String(req.url).includes(req.elicitationId), "the id is random and not in the link");
      assert.notEqual(req.elicitationId, new URL(req.url).searchParams.get("t"), "the id is not the token");
      assert.equal(k.wire.length, 0, "a missing entry sends nothing");
      assert.equal((await k.run()).error, true);
      assert.equal(k.requests.length, 1, "the same page, not a second request");
      assert.equal(k.wire.length, 0);
      assert.equal((await submit({ url: req.url } as Page, "pw-1")).status, 200);
      await k.settle();
      assert.equal(k.wire.length, 0, "a submission sends nothing");
      assert.ok(k.notes.some((n) => n.includes("elicitation/complete") && n.includes(req.elicitationId)), "the completion fires after the submit");
      assert.equal((await k.run()).error, false);
      assert.deepEqual(k.wire, ["pw-1"], "the next call sends exactly once");
      assert.equal((await k.run()).error, false);
      assert.equal(k.wire.length, 1);
      assert.ok(k.requests.every((q) => q.mode === "url"));
    } finally {
      await k.close();
    }
  }));

for (const how of ["decline", "error"] as const)
  test(`signon delivery: a ${how} prints the link for the same page`, () =>
    sandbox(async (root) => {
      const k = await wired(root, { url: how });
      try {
        await k.run();
        await k.settle();
        const r = await k.run();
        assert.equal(r.text.match(LINK)?.[0], k.url(), "the link is the elicited page's");
        assert.equal(k.requests.length, 1);
        assert.equal((await submit({ url: k.url() } as Page, "pw-d")).status, 200);
        await k.settle();
        assert.ok(!k.notes.some((n) => n.includes("elicitation/complete")), "a declined page sends no completion");
      } finally {
        await k.close();
      }
    }));

test("signon delivery: a client that never answers cannot hold the sign-on; after 10 seconds the link prints", () =>
  sandbox(async (root) => {
    const k = await wired(root, { url: "never" });
    try {
      assert.ok(!LINK.test((await k.run()).text));
      await k.settle();
      clock += ELICIT_WINDOW_MS - 1;
      assert.ok(!LINK.test((await k.run()).text), "still inside the window");
      clock += 1;
      const r = await k.run();
      assert.equal(r.text.match(LINK)?.[0], k.url());
      assert.equal(k.requests.length, 1);
      assert.equal(k.wire.length, 0);
    } finally {
      await k.close();
    }
  }));

// A stored password the box rejects: the guard's identity lookup sends it once, the tool's own query hits the
// latch and is the call that offers the page. Returns the kit with exactly that state.
async function rejectedStale(root: string) {
  const k = await wired(root, { url: "accept" });
  store("stale-1");
  k.st.reject = true;
  assert.equal((await k.run()).error, true);
  await k.settle();
  assert.deepEqual(k.wire, ["stale-1"], "the stored password is sent once");
  assert.equal(k.requests.length, 1, "one page for the rejected password");
  assert.match((await k.run()).text, /not sent: that password was rejected earlier/);
  assert.deepEqual(k.wire, ["stale-1"], "the latch refused before the box");
  return k;
}

test("signon retry: after a rejected password, a submitted different value sends exactly once", () =>
  sandbox(async (root) => {
    const k = await rejectedStale(root);
    try {
      assert.equal((await submit({ url: k.url() } as Page, "fresh-2")).status, 200);
      assert.deepEqual(k.wire, ["stale-1"], "a submission sends nothing");
      k.st.reject = false;
      assert.equal((await k.run()).error, false);
      assert.deepEqual(k.wire, ["stale-1", "fresh-2"], "the next call sends exactly once");
      assert.equal((await k.run()).error, false);
      assert.equal(k.wire.length, 2);
    } finally {
      await k.close();
    }
  }));

test("signon retry: after a rejected password, the same value submitted again sends nothing", () =>
  sandbox(async (root) => {
    const k = await rejectedStale(root);
    try {
      assert.equal((await submit({ url: k.url() } as Page, "stale-1")).status, 200);
      for (let i = 0; i < 2; i++) assert.match((await k.run()).text, /not sent: that password was rejected earlier/);
      assert.deepEqual(k.wire, ["stale-1"], "an unchanged password is refused with no send");
      await k.settle();
      assert.equal(k.requests.length, 1, "no second page");
    } finally {
      await k.close();
    }
  }));

test("signon retry: stale entry rejected, page, rejected, no page; first-time page, rejected, page, rejected, no page", () =>
  sandbox(async (root) => {
    const k = await wired(root, { url: "accept" });
    try {
      k.st.reject = true;
      // First time: no entry -> page -> submit -> rejected -> page -> submit -> rejected -> no page.
      assert.equal((await k.run()).error, true);
      await k.settle();
      assert.equal(k.requests.length, 1);
      await submit({ url: k.url() } as Page, "pw-a");
      assert.equal((await k.run()).error, true);
      assert.deepEqual(k.wire, ["pw-a"]);
      await k.run();
      await k.settle();
      assert.equal(k.requests.length, 2, "the rejected password gets a page");
      await submit({ url: k.url() } as Page, "pw-b");
      await k.run();
      assert.deepEqual(k.wire, ["pw-a", "pw-b"]);
      const last = await k.run();
      await k.settle();
      assert.equal(k.requests.length, 2, "then no page");
      assert.ok(!LINK.test(last.text) && /not sent: that password was rejected earlier/.test(last.text), last.text);
      assert.match(last.text, /credential set/);
      assert.match(last.text, /restart/);
      assert.equal(k.wire.length, 2);
    } finally {
      await k.close();
    }
  }));

test("signon retry: an expired offer does not count; helper and plain profiles get no offer", () =>
  sandbox(async (root) => {
    const k = await wired(root);
    try {
      store("stale-1");
      k.st.reject = true;
      await k.run();
      const first = (await k.run()).text.match(LINK)![0];
      clock += PAGE_TTL_MS;
      const second = (await k.run()).text.match(LINK)![0];
      assert.notEqual(first, second, "an expired page is replaced");
      assert.equal((await submit({ url: second } as Page, "pw-x")).status, 200);
      await k.run();
      assert.deepEqual(k.wire, ["stale-1", "pw-x"], "the expired offer cost nothing: the submitted one still sent");
    } finally {
      await k.close();
    }
    for (const [name, profile] of [
      ["plain", { passwordStore: undefined, password: "Plain1x" }],
      ["helper", { passwordStore: undefined, passwordCommand: `"${process.execPath}" "${join(root, "h.mjs")}"`, profileFile: join(root, ".env.dev") }],
    ] as const) {
      writeFileSync(join(root, "h.mjs"), `process.stdout.write("HelperPw1");\n`);
      const p = await wired(root, { url: "accept", profile });
      try {
        p.st.reject = true;
        for (let i = 0; i < 2; i++) assert.ok(!LINK.test((await p.run()).text), name);
        await p.settle();
        assert.equal(p.requests.length, 0, `${name}: no page offered`);
        assert.equal(p.wire.length, 1, `${name}: sent once`);
      } finally {
        await p.close();
      }
    }
  }));

test("signon secret: a marker password is in no tool result, notification, run log, stderr or page response, on every path", () =>
  sandbox(async (root) => {
    const k = await wired(root, { url: "accept" });
    const pages: string[] = [];
    try {
      // Store failure (the store's error echoes the secret) then accepted.
      await k.run();
      await k.settle();
      failSet = new Error(`keyring said no to ${MARKER}`);
      pages.push((await submit({ url: k.url() } as Page, MARKER)).text);
      failSet = undefined;
      assert.equal(vault.size, 0);
      await k.run();
      await k.settle();
      assert.equal(k.requests.length, 2, "a failed store used the link up, so a new page");
      pages.push((await submit({ url: k.url() } as Page, MARKER)).text);
      assert.equal(vault.get("BOB@box.example.com"), MARKER);
      // Rejected: the box's error even quotes the password.
      k.st.reject = true;
      assert.equal((await k.run()).error, true);
      assert.deepEqual(k.wire, [MARKER]);
      await k.run();
      await k.settle();
      pages.push((await submit({ url: k.url() } as Page, MARKER)).text, (await call(k.url())).text);
      await k.run();
      await k.settle();
    } finally {
      await k.close();
    }
    const enc = encodeURIComponent(MARKER);
    const where: [string, string][] = [
      ["tool results", k.results.join("\n")],
      ["notifications", k.notes.join("\n")],
      ["run log", k.logs()],
      ["stderr", stderrText.join("")],
      ["page responses", pages.join("\n")],
    ];
    for (const [what, text] of where) assert.ok(!text.includes(MARKER) && !text.includes(enc), `${what} holds the password`);
  }));

test("signon wiring: createServer installs no hook, serve() does, shutdown closes the listener", () =>
  sandbox(async (root) => {
    const k = await wired(root, { hook: false });
    try {
      assert.equal(signOnPageInstalled(), false, "createServer alone installs no hook");
      setSignOnPage(k.kit.signOn.hook);
      assert.equal(signOnPageInstalled(), true);
      const link = (await k.run()).text.match(LINK)![0];
      assert.equal((await call(link)).status, 200);
      await k.close();
      await assert.rejects(call(link), "the listener is closed after shutdown");
    } finally {
      await k.close().catch(() => {});
    }
  }));

test("signon list_servers: the setup page is offered only when no profile exists, and the tool stays read-only", () =>
  sandbox(async (root) => {
    const k = await wired(root, { url: "accept" });
    try {
      const first = await k.tool("list_servers");
      assert.match(first.text, /No profile exists yet/);
      await k.settle();
      assert.equal(k.requests.length, 1);
      assert.equal(k.requests[0].mode, "url");
      assert.ok(!LINK.test(first.text), "the prompt carries it");
      mkdirSync(join(root, "config"), { recursive: true });
      writeFileSync(join(root, "config", ".env.dev"), "IBMI_HOST=h\nIBMI_USER=BOB\nIBMI_PASSWORD_STORE=os\n");
      const second = await k.tool("list_servers");
      assert.ok(!/No profile exists yet|127\.0\.0\.1/.test(second.text) && !/setup page/.test(second.text), second.text);
      assert.equal(k.requests.length, 1, "a profile exists: no new page");
    } finally {
      await k.close();
    }
  }));

test("signon list_servers: a client without elicitation.url gets the link; readOnlyHint is kept", () =>
  sandbox(async (root) => {
    const k = await wired(root);
    try {
      assert.match((await k.tool("list_servers")).text, LINK);
      assert.equal(k.requests.length, 0);
      const tool = (await k.client.listTools()).tools.find((t) => t.name === "list_servers");
      assert.equal(tool?.annotations?.readOnlyHint, true);
    } finally {
      await k.close();
    }
  }));

test("signon standalone: with no hook installed the engines' missing-entry and unknown-server texts are unchanged", () =>
  sandbox(async (root) => {
    const k = await wired(root, { url: "accept", hook: false });
    try {
      const r = await k.run();
      assert.ok(r.error);
      assert.ok(r.text.includes("no OS credential store entry for BOB@box.example.com. Run `ibmi-agent-kit credential set <profile>`, or set IBMI_PASSWORD_COMMAND in the profile"), r.text);
      assert.ok(!/127\.0\.0\.1|page|prompt/i.test(r.text.replace(/[^.]*credential store[^.]*\./i, "")), r.text);
      await k.settle();
      assert.equal(k.requests.length, 0);
      assert.throws(() => resolveProfileEnv("nosuch"), /Available: none$/);
      setSignOnPage(k.kit.signOn.hook);
      assert.throws(() => resolveProfileEnv("nosuch"), /Available: none; list_servers offers a setup page$/);
    } finally {
      await k.close();
    }
  }));
