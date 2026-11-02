import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Where a profile's password comes from, and the one place it is sent from. The kit never writes a
// plain password; a helper command or the OS store supplies it, once per send.

export interface PasswordSource {
  password?: string;
  passwordCommand?: string;
  passwordStore?: "os";
  profileFile?: string;
}
export interface SignOnProfile extends PasswordSource {
  host: string;
  user: string;
}

const SERVICE = "ibmi-agent-kit";
const HELPER_HINT = "set IBMI_PASSWORD_COMMAND in the profile";
const SCRIPT_FORM = "powershell -NoProfile -File <script>";

// Fields for loadProfile, from the env resolveProfileEnv built. A plain password is allowed but warned.
export function passwordSource(env: Record<string, string | undefined>): PasswordSource {
  const store = env.IBMI_PASSWORD_STORE || undefined;
  if (store !== undefined && store !== "os") {
    throw new Error(`IBMI_PASSWORD_STORE must be "os" (the OS credential store), not "${store}"`);
  }
  const src: PasswordSource = {
    password: env.IBMI_PASSWORD || undefined,
    passwordCommand: env.IBMI_PASSWORD_COMMAND || undefined,
    passwordStore: store as "os" | undefined,
    profileFile: env.IBMI_KIT_PROFILE_FILE || undefined,
  };
  if (!src.password && !src.passwordCommand && !src.passwordStore) {
    throw new Error(
      "missing a password source in the env file: set IBMI_PASSWORD_STORE=os (then `ibmi-agent-kit credential set <profile>`) or IBMI_PASSWORD_COMMAND",
    );
  }
  return src;
}

// ---- helper command ----

// Whitespace separates arguments outside double quotes; a double quote toggles quoting and is
// removed; a backslash and a single quote are literal. One rule, so a Windows path needs no escaping.
export function splitCommand(text: string): string[] {
  if (/[\r\n]/.test(text)) throw new Error("IBMI_PASSWORD_COMMAND must be one line");
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quoted = false;
  for (const c of text) {
    if (c === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(c)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quoted) throw new Error("IBMI_PASSWORD_COMMAND has an unterminated double quote");
  if (started) out.push(cur);
  if (out.length === 0) throw new Error("IBMI_PASSWORD_COMMAND is empty");
  return out;
}

// Node cannot run a batch or script file without a shell, and a shell would reopen injection.
export function parseHelperCommand(text: string): { file: string; args: string[] } {
  const [file, ...args] = splitCommand(text);
  if (/\.(cmd|bat|ps1)$/i.test(file)) {
    throw new Error(`password helper "${file}" is a script file and cannot run without a shell. Run it as ${SCRIPT_FORM}`);
  }
  return { file, args };
}

const HELPER_MS = 30_000;
const HELPER_BYTES = 64 * 1024;

// The helper's stdout, UTF-8, BOM and one line ending removed. Errors name the executable and the
// reason only: its output, its stderr (dropped) and its arguments never reach a message.
export function runHelper(file: string, args: string[], o: { timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
  const { timeoutMs = HELPER_MS, maxBytes = HELPER_BYTES } = o;
  return new Promise((resolve, reject) => {
    let done = false;
    let child: ChildProcess | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
    const fail = (why: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child?.kill();
        child?.stdout?.destroy();
      } catch {
        // already gone
      }
      reject(new Error(`password helper "${file}" ${why}`));
    };
    try {
      // cwd is home: a bare name must not resolve from the host's project, which may be untrusted.
      child = spawn(file, args, { cwd: homedir(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false });
    } catch (e) {
      return fail(`could not start (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
    child.on("error", (e) => fail(`could not start (${(e as NodeJS.ErrnoException).code ?? "error"})`));
    child.stdout!.on("data", (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) return fail(`wrote more than ${maxBytes / 1024} KiB`);
      chunks.push(d);
    });
    child.on("close", (code, sig) => {
      if (done) return;
      if (code !== 0) return fail(code === null ? `was stopped by signal ${sig}` : `exited with code ${code}`);
      const text = Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "").replace(/\r?\n$/, "");
      if (!text) return fail("printed nothing");
      done = true;
      clearTimeout(timer);
      resolve(text);
    });
  });
}

// ---- git work tree refusal ----

// The folder holding a `.git` entry (a file in a linked work tree), at or above the nearest existing
// part of `path`, by real path so a link cannot hide it.
export function gitWorkTree(path: string): string | undefined {
  let dir = path;
  for (;;) {
    try {
      dir = realpathSync(dir);
      break;
    } catch {
      const up = dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
  }
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function refuseGit(file: string | undefined): void {
  // No recorded path means we cannot tell where the line came from: refuse rather than guess.
  if (!file) throw new Error(`password helper refused: the profile file is unknown. Use IBMI_PASSWORD_STORE=os`);
  if (gitWorkTree(file)) {
    throw new Error(
      `password helper refused: ${file} is inside a git work tree, where a pulled change could add a command. Use IBMI_PASSWORD_STORE=os, or keep the profile in a folder outside the work tree`,
    );
  }
}

// ---- OS store ----

export interface CredentialStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

// Upper-case user and lower-case host, so an edited host finds no entry instead of the old password.
export const credentialAccount = (user: string, host: string): string => `${user.toUpperCase()}@${host.toLowerCase()}`;

// The default on Linux falls back silently to the kernel keyring, lost at restart: pin the Secret Service.
export const KEYRING_OPTIONS = { linux: { store: "secret-service" } } as const;

const realStore: CredentialStore = (() => {
  const entry = async (account: string) => {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(SERVICE, account, KEYRING_OPTIONS);
  };
  return {
    get: async (a) => (await entry(a)).getPassword(),
    set: async (a, s) => (await entry(a)).setPassword(s),
    delete: async (a) => (await entry(a)).deletePassword(),
  };
})();

let store: CredentialStore = realStore;
// Test seam: install a fake, or call with no argument to go back to the real store.
export const setCredentialStore = (s?: CredentialStore): void => {
  store = s ?? realStore;
};

const reason = (e: unknown, secret?: string): string => {
  const m = e instanceof Error ? e.message : String(e);
  return secret ? m.split(secret).join("***") : m;
};

export async function storeSecret(user: string, host: string, secret: string): Promise<void> {
  try {
    await store.set(credentialAccount(user, host), secret);
  } catch (e) {
    throw new Error(`the OS credential store cannot be written (${reason(e, secret)}). Instead, ${HELPER_HINT}`);
  }
}

export async function deleteStoredSecret(user: string, host: string): Promise<boolean> {
  try {
    return await store.delete(credentialAccount(user, host));
  } catch (e) {
    throw new Error(`the OS credential store cannot be changed (${reason(e)}). Instead, ${HELPER_HINT}`);
  }
}

async function readStored(user: string, host: string): Promise<string> {
  const account = credentialAccount(user, host);
  let v: string | null;
  try {
    v = await store.get(account);
  } catch (e) {
    throw new Error(
      `the OS credential store cannot be read (${reason(e)}). Fix it, or ${HELPER_HINT}`,
    );
  }
  if (!v) throw new Error(`no OS credential store entry for ${account}. Run \`ibmi-agent-kit credential set <profile>\`, or ${HELPER_HINT}`);
  return v;
}

// ---- fetch and send ----

const last = new Map<string, string>();
const warned = new Set<string>();
const rejected = new Map<string, string>();
const chains = new Map<string, Promise<unknown>>();

const warn = (file: string | undefined, text: string): void => {
  const k = file ?? "";
  if (warned.has(k)) return;
  warned.add(k);
  process.stderr.write(`ibmi-agent-kit: warning: ${file ?? "the profile"} ${text}\n`);
};

// Precedence helper, store, plain line, with no fallback: after a failure another source would send a
// stale password and burn an attempt. Remembers the value as lastSecret for masking.
export async function fetchSecret(p: SignOnProfile): Promise<string> {
  let secret: string;
  if (p.passwordCommand) {
    if (p.password) warn(p.profileFile, "holds IBMI_PASSWORD, which is ignored because a password source is set: remove it and change that password");
    refuseGit(p.profileFile);
    const { file, args } = parseHelperCommand(p.passwordCommand);
    secret = await runHelper(file, args);
  } else if (p.passwordStore) {
    if (p.password) warn(p.profileFile, "holds IBMI_PASSWORD, which is ignored because a password source is set: remove it and change that password");
    secret = await readStored(p.user, p.host);
  } else if (p.password) {
    warn(p.profileFile, "holds a plain IBMI_PASSWORD. Run `ibmi-agent-kit setup` to move it to the OS store");
    secret = p.password;
  } else {
    throw new Error("no password source: set IBMI_PASSWORD_STORE=os or IBMI_PASSWORD_COMMAND");
  }
  last.set(credentialAccount(p.user, p.host), secret);
  return secret;
}

// The last password fetched for this user and host; never fetches. For masking.
export const lastSecret = (host: string, user: string): string | undefined => last.get(credentialAccount(user, host));

// Every place that sends a password goes through here: one at a time per user and host, and a password
// the box rejected is not sent again until it changes. `isRejected` must be true only for an
// authentication failure, so a down host never latches.
export function signOnOnce<T>(p: SignOnProfile, send: (secret: string) => Promise<T>, isRejected: (e: unknown) => boolean): Promise<T> {
  const key = credentialAccount(p.user, p.host);
  const attempt = async (): Promise<T> => {
    const secret = await fetchSecret(p);
    if (rejected.get(key) === secret) {
      throw new Error(
        `sign-on for ${key} not sent: that password was rejected earlier in this process and has not changed. Change it in the OS store, the password helper or the profile, then retry; or restart the server to try the same password again`,
      );
    }
    try {
      const r = await send(secret);
      rejected.delete(key);
      return r;
    } catch (e) {
      if (isRejected(e)) rejected.set(key, secret);
      throw e;
    }
  };
  const run = (chains.get(key) ?? Promise.resolve()).then(attempt);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

// Test only: the latch, the chains, the remembered secrets and the once-only warnings are process-wide.
export function resetSignOnState(): void {
  last.clear();
  warned.clear();
  rejected.clear();
  chains.clear();
}
