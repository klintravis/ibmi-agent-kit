// The sign-on page server (signon-page 3.x): real loopback HTTP, a fake credential store, profile folders
// in a temp dir. No real OS store, no profile of this machine, no IBM i. Imported by selfcheck.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProfile, resetSignOnState, resolveProfileEnv, setCredentialStore, type CredentialStore, type SignOnProfile } from "@ibmi-agent-kit/core";
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
  const plain = join(root, "plain");
  mkdirSync(plain);
  const pages = new SignOnPages({ now: () => clock, cwd: () => (cwd ? cwd(root) : plain) });
  try {
    await body(root, pages);
  } finally {
    pages.close();
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
  call(p.url, { method: "POST", body: new URLSearchParams(fields).toString(), path: "/", ...o });
const submit = (p: Page, password = MARKER, extra: Record<string, string> = {}) => post(p, { t: tokenOf(p), password, ...extra });

function everyHeader(r: Res, what: string) {
  assert.equal(r.headers["cache-control"], "no-store", what);
  assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/, what);
  assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/, what);
  assert.equal(r.headers["referrer-policy"], "no-referrer", what);
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
