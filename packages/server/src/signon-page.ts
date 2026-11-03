// The sign-on page: a loopback listener, opened on the first offer, that takes a password (or a first
// profile) from a person's own browser and writes it to the OS store. It sends nothing to the IBM i. The
// protections follow packages/screen/src/viewer.ts: loopback bind, Host allowlist, random token, no framing.
// Delivery (elicitation, the link text) and wiring into createServer belong to the caller; this module
// only makes pages, serves them and counts re-offers.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { CONFIG_DIRS, credentialAccount, gitWorkTree, listServers, storeSecret, type SignOnProfile } from "@ibmi-agent-kit/core";
import { companyRepo, fileFor, message, OWN, planProfile, policyError, readSkeleton, repoLeak, writeProfile } from "./profile-write.js";

export const PAGE_TTL_MS = 5 * 60_000;
const MAX_BODY = 4096;
const FIRST = "first-profile";

// A page as the offer logic sees it: the link, when it was offered, and the delivery state it sets.
export class Page {
  url = "";
  elicitationId?: string; // set when the page was offered through elicitation
  answered = false; // the client declined or the request failed
  onAccepted?: () => void | Promise<void>; // runs after an accepted submission; a failure is swallowed
  constructor(readonly born: number) {}
}

interface Partition {
  name: string;
  host: string;
}
interface Entry {
  page: Page;
  token: string;
  key: string;
  expires: number;
  ready: Promise<void>;
  account?: { p: SignOnProfile; why: "missing" | "rejected" };
  first?: { cwd: string; partitions?: Partition[] }; // partitions: set in a company repo
}
type Values = { host?: string; user?: string; partition?: string };
type Send = (status: number, body: string, html?: boolean) => void;

const HEADERS = {
  "cache-control": "no-store",
  // Inline style only: no script, no fetch, no framing, no base, posts only to itself.
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  connection: "close",
};
const GONE = "this link is not valid: it expired, was used, or is wrong. Ask your assistant to try again for a new one.";
export const TERMINAL = "Run `ibmi-agent-kit setup` or `ibmi-agent-kit credential set <profile>` in a terminal instead.";

const esc = (s: string) => s.replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
const shell = (body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ibmi-agent-kit sign-on</title>` +
  `<style>body{font:16px system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.8rem 0}` +
  `input,select{font:inherit;width:100%;box-sizing:border-box}.err{color:#b00020}.warn{border-left:4px solid #c60;padding-left:.8rem}</style><body>${body}`;
const WARN =
  `<p class="warn"><b>A wrong password counts as a failed sign-on</b> toward QMAXSIGN on the IBM i and can disable the user. ` +
  `This kit sends a stored password once and then stops; it cannot see QMAXSIGN. After one wrong password it offers this page one more time, per server process.</p>`;

// The folder the first profile would go to must not be a git work tree, nor lie in the company repo.
function unsafe(cwd: string, repo: ReturnType<typeof companyRepo>): string | undefined {
  const [dir] = CONFIG_DIRS();
  const tree = gitWorkTree(dir);
  if (tree) return `the profile folder ${dir} is inside the git work tree ${tree}, so no profile is written there from a page. Use a profile folder outside it (IBMI_KIT_CONFIG_DIR). ${TERMINAL}`;
  const leak = repo && repoLeak(cwd, dir, repo.partitions);
  if (leak) return `${leak} lies inside the company config repo ${cwd}, so a profile would land in the repo. Use a profile folder outside it (IBMI_KIT_CONFIG_DIR). ${TERMINAL}`;
}

const hostOf = (skeletons: string, name: string): string => {
  try {
    return readSkeleton(skeletons, name).skeleton.IBMI_HOST?.trim() ?? "";
  } catch {
    return "";
  }
};

function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((done) => {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return done(undefined);
    const chunks: Buffer[] = [];
    let n = 0;
    // shortcut: an over-long chunked body is read and dropped to its end, bounded by the server's request timeout.
    req.on("data", (c: Buffer) => ((n += c.length) <= MAX_BODY ? chunks.push(c) : done(undefined)));
    req.on("end", () => done(n <= MAX_BODY ? Buffer.concat(chunks).toString("utf8") : undefined));
    req.on("error", () => done(undefined));
  });
}

export class SignOnPages {
  private server?: http.Server;
  private port?: Promise<number>;
  private timer?: NodeJS.Timeout;
  private byToken = new Map<string, Entry>();
  private byKey = new Map<string, Entry>();
  private reoffered = new Set<string>(); // accounts whose re-offer page was submitted in this process

  constructor(private o: { now?: () => number; cwd?: () => string } = {}) {}
  private now = () => (this.o.now ?? Date.now)();

  // The page for an account: the pending one when there is one, else a new one. `undefined` when a
  // re-offer was already submitted for this account (D6): the caller's error then stands.
  async offer(p: SignOnProfile, why: "missing" | "rejected"): Promise<Page | undefined> {
    const key = credentialAccount(p.user, p.host);
    const live = this.pending(key);
    if (live) return live.ready.then(() => live.page);
    if (why === "rejected" && this.reoffered.has(key)) return undefined;
    return this.open(key, { account: { p, why } });
  }

  // The first-profile page. `undefined`: profiles exist, nothing to offer. `refused`: why none is offered.
  async firstProfile(): Promise<{ page: Page } | { refused: string } | undefined> {
    if (listServers().length) return undefined;
    const live = this.pending(FIRST);
    if (live) return live.ready.then(() => ({ page: live.page }));
    const cwd = resolve(this.o.cwd?.() ?? process.cwd());
    const repo = companyRepo(cwd);
    if (repo && !repo.partitions.length) return { refused: `the company config repo ${cwd} has no profile skeleton (profiles/.env.<partition>). ${TERMINAL}` };
    const refused = unsafe(cwd, repo);
    if (refused) return { refused };
    const partitions = repo?.partitions.map((name) => ({ name, host: hostOf(repo.skeletons, name) }));
    return { page: await this.open(FIRST, { first: { cwd, partitions } }) };
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.byToken.clear();
    this.byKey.clear();
    this.stop(true);
  }

  // ---- pages ----

  private pending(key: string): Entry | undefined {
    const e = this.byKey.get(key);
    if (e && this.now() >= e.expires) return void this.drop(e);
    return e;
  }
  private drop(e: Entry) {
    this.byToken.delete(e.token);
    if (this.byKey.get(e.key) === e) this.byKey.delete(e.key);
  }
  // Closes the listener once no page is left. Only the timer calls it, so a used link still gets its refusal.
  private sweep() {
    for (const e of this.byToken.values()) if (this.now() >= e.expires) this.drop(e);
    if (!this.byToken.size) this.stop(false);
  }
  private stop(force: boolean) {
    const s = this.server;
    this.server = this.port = undefined;
    s?.close();
    force ? s?.closeAllConnections() : s?.closeIdleConnections();
  }

  private async open(key: string, rest: Pick<Entry, "account" | "first">): Promise<Page> {
    const token = randomBytes(16).toString("hex");
    const now = this.now();
    const e: Entry = { page: new Page(now), token, key, expires: now + PAGE_TTL_MS, ready: undefined!, ...rest };
    // Registered before the listener is awaited, so a second offer for this key finds this page.
    this.byToken.set(token, e);
    this.byKey.set(key, e);
    e.ready = this.listen().then(
      (port) => void (e.page.url = `http://127.0.0.1:${port}/?t=${token}`),
      (err) => (this.drop(e), Promise.reject(err)),
    );
    await e.ready;
    this.arm();
    return e.page;
  }
  // One unref'd timer sweeps expired pages and closes the listener when none is left. The injected
  // clock is for the check; the timer itself runs on real time.
  private arm() {
    if (this.timer) return;
    this.timer = setTimeout(() => ((this.timer = undefined), this.sweep(), this.byToken.size && this.arm()), PAGE_TTL_MS).unref();
  }

  private listen(): Promise<number> {
    return (this.port ??= new Promise<number>((ok, fail) => {
      const s = http.createServer((req, res) => void this.route(req, res));
      this.server = s;
      s.on("error", (err) => {
        if (this.server === s) this.server = this.port = undefined;
        fail(err);
      });
      s.listen(0, "127.0.0.1", () => ok((s.address() as AddressInfo).port));
      s.unref();
    }));
  }

  // ---- requests ----

  // DNS rebinding defence, as in the viewer: any site can point its own name at 127.0.0.1.
  private allowedHost(req: http.IncomingMessage): boolean {
    const name = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
  }
  private live(token: string | null | undefined): Entry | undefined {
    const e = token ? this.byToken.get(token) : undefined;
    if (e && this.now() >= e.expires) return void this.drop(e);
    return e;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse) {
    const send: Send = (status, body, html = false) => {
      res.writeHead(status, { ...HEADERS, "content-type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" });
      res.end(body);
    };
    const refuse = (status: number, why: string) => send(status, `refused: ${why}\n`);
    try {
      if (!this.allowedHost(req)) return refuse(403, "this page answers only on the local machine");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") return refuse(404, "not found");
      // The query string supplies the token and nothing else.
      if (req.method === "GET") {
        const e = this.live(url.searchParams.get("t"));
        return e ? send(200, this.render(e), true) : refuse(403, GONE);
      }
      if (req.method !== "POST") return refuse(405, "GET or POST only");
      const origin = req.headers.origin;
      if (origin !== undefined && origin.toLowerCase() !== `http://${req.headers.host}`.toLowerCase()) return refuse(403, "foreign origin");
      if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return refuse(415, "a form post only");
      const body = await readBody(req); // the size limit, before anything is parsed
      if (body === undefined) return refuse(413, "the request is too large");
      const form = new URLSearchParams(body);
      const e = this.live(form.get("t")); // the token comes from the body, never the query string
      if (!e) return refuse(403, GONE);
      if (e.account) await this.submitAccount(e, form.get("password") ?? "", send);
      else await this.submitFirst(e, form, send);
    } catch {
      refuse(500, "internal error"); // never the exception text: it could hold request data
    }
  }

  // A claimed page is gone at once, so of two racing POSTs only one finds the token.
  private claim(e: Entry) {
    this.drop(e);
  }

  private async submitAccount(e: Entry, password: string, send: Send) {
    if (!password) return send(400, this.render(e, {}, "Enter the password."), true);
    this.claim(e);
    const { p, why } = e.account!;
    try {
      await storeSecret(p.user, p.host, password);
    } catch (err) {
      return send(500, shell(`<h1>Not saved</h1><p>${esc(message(err).split(password).join("***"))}</p><p>Ask your assistant to try again for a new page. ${esc(TERMINAL)}</p>`), true);
    }
    if (why === "rejected") this.reoffered.add(e.key);
    void Promise.resolve().then(() => e.page.onAccepted?.()).catch(() => {});
    send(200, shell(`<h1>Saved</h1><p>The password for ${esc(p.user)} on ${esc(p.host)} is in the OS credential store. It has not been tried. Go back to your assistant and ask it to try again.</p>`), true);
  }

  private async submitFirst(e: Entry, f: URLSearchParams, send: Send) {
    const v: Values = { host: f.get("host")?.trim(), user: f.get("user")?.trim(), partition: f.get("partition") ?? undefined };
    const password = f.get("password") ?? "";
    const again = (why: string) => send(400, this.render(e, v, why), true); // fixable input: the page stays
    const refuse = (why: string) => (this.claim(e), send(403, shell(`<h1>Nothing was written</h1><p>${esc(why)}</p>`), true));
    const { cwd } = e.first!;
    const [dir] = CONFIG_DIRS();
    if (listServers().length) return refuse(`a profile exists now. Nothing is changed. ${TERMINAL}`);
    const repo = companyRepo(cwd);
    if (!!repo !== !!e.first!.partitions) return refuse("the folder changed since the page was offered, so nothing was written.");
    const bad = unsafe(cwd, repo);
    if (bad) return refuse(bad);
    if (!v.user) return again("Enter the IBM i user.");
    if (!password) return again("Enter the password.");

    let name = "default";
    let host = v.host ?? "";
    const values: [string, string][] = [];
    let warnings: string[] = [];
    if (repo) {
      name = v.partition || (repo.partitions.length === 1 ? repo.partitions[0] : "");
      if (!repo.partitions.includes(name)) return again("Choose a partition from the list.");
      const read = readSkeleton(repo.skeletons, name);
      if (read.error) return refuse(`${read.error}. Nothing was written.`);
      warnings = read.warnings;
      values.push(...Object.entries(read.skeleton).filter(([k]) => !OWN.has(k)));
      host = read.skeleton.IBMI_HOST.trim();
      const policy = join(cwd, "policy.yaml");
      const badPolicy = policyError(policy);
      if (badPolicy) return refuse(`${badPolicy}. Nothing was written.`);
      values.push(["IBMI_KIT_POLICY", policy]);
    } else {
      if (!host) return again("Enter the IBM i host.");
      values.push(["IBMI_HOST", host]);
    }
    const path = join(dir, fileFor(name)!);
    if (existsSync(path)) return refuse(`a profile named "${name}" exists now. Nothing was written.`);
    values.push(["IBMI_USER", v.user], ["IBMI_PASSWORD_STORE", "os"]);
    const plan = planProfile("", {}, values, ["IBMI_PASSWORD", "IBMI_PASSWORD_COMMAND"], path);
    if ("error" in plan) return again(plan.error);

    this.claim(e);
    // shortcut: a profile created between the checks above and the rename is overwritten; setup has the same window.
    const failed = await writeProfile({ dir, path, next: plan.next, user: v.user, host, password, store: true });
    if (failed) {
      const text = failed.stored ? failed.error : `${failed.error}. Nothing was written.`;
      return send(500, shell(`<h1>Not saved</h1><p>${esc(text.split(password).join("***"))}</p><p>${esc(TERMINAL)}</p>`), true);
    }
    void Promise.resolve().then(() => e.page.onAccepted?.()).catch(() => {});
    const warn = warnings.map((w) => `<p class="err">${esc(w.trim())}</p>`).join("");
    send(200, shell(`<h1>Saved</h1><p>Profile "${esc(name)}" now exists for ${esc(v.user)} on ${esc(host)}, and its password is in the OS credential store. Nothing was tried. Go back to your assistant and ask it to try again.</p>${warn}`), true);
  }

  // ---- the form ----

  private render(e: Entry, v: Values = {}, error?: string): string {
    const err = error ? `<p class="err">${esc(error)}</p>` : "";
    const t = `<input type="hidden" name="t" value="${e.token}">`;
    const pw = `<label>Password<input type="password" name="password" autocomplete="off" required></label>`;
    const send = `<button type="submit">Save</button>`;
    const note = `<p>The password goes to this computer's OS credential store only. It is not sent to the IBM i, and not to your assistant.</p>`;
    if (e.account) {
      const { p } = e.account;
      return shell(`<h1>Password for ${esc(p.user)} on ${esc(p.host)}</h1>${note}${WARN}${err}<form method="post" action="/" autocomplete="off">${t}${pw}${send}</form>`);
    }
    const parts = e.first!.partitions;
    let who: string;
    if (!parts) who = `<label>IBM i host<input name="host" value="${esc(v.host ?? "")}" autocomplete="off" required></label>`;
    else if (parts.length === 1) who = `<p>Partition ${esc(parts[0].name)} on host ${esc(parts[0].host)}. The profile is named ${esc(parts[0].name)}.</p>`;
    else {
      const options = parts.map((x) => `<option value="${esc(x.name)}"${v.partition === x.name ? " selected" : ""}>${esc(x.name)} (${esc(x.host)})</option>`).join("");
      who = `<label>Partition<select name="partition" required><option value="">Choose</option>${options}</select></label>`;
    }
    const user = `<label>IBM i user<input name="user" value="${esc(v.user ?? "")}" autocomplete="off" required></label>`;
    return shell(`<h1>Set up your first IBM i profile</h1>${note}${WARN}${err}<form method="post" action="/" autocomplete="off">${t}${who}${user}${pw}${send}</form>`);
  }
}
