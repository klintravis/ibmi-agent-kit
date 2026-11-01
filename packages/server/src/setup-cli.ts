// `ibmi-agent-kit setup [name]`: writes or updates one profile file from a terminal, then tests it
// by reading the file back and connecting. Returns the exit code: 0 OK, 1 the test failed (the file
// stays written), 2 a usage error or refusal (nothing written), 130 cancelled (nothing written).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIRS, listServers, parseProfile, resolveProfileEnv, serverName } from "@ibmi-agent-kit/core";
import { loadPolicy } from "@ibmi-agent-kit/guard";
import { loadProfile, MapepireBackend } from "@ibmi-agent-kit/source/tools";

export interface Input extends NodeJS.EventEmitter {
  isTTY?: boolean;
  readableEnded?: boolean;
  setRawMode?(on: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
}
type Write = (text: string) => void;
export type Probe = { query(sql: string): Promise<{ rows: Record<string, unknown>[] }>; close(): Promise<void> };
export interface SetupDeps {
  input: Input;
  out: Write;
  err: Write;
  connect(env: Record<string, string>): Probe;
}

const USAGE = "usage: ibmi-agent-kit setup [name]\n";
export const SETUP_SQL = "SELECT CURRENT USER, CURRENT SERVER FROM SYSIBM.SYSDUMMY1";
class Cancelled extends Error {}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The file a name is written to: only names core lists as that server, from characters safe in a
// file name on every OS (Windows drops a trailing dot, so `x.` would never be listed as `x.`).
export function fileFor(name: string): string | undefined {
  const file = name === "default" ? ".env" : `.env.${name}`;
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..") && !name.endsWith(".");
  return safe && serverName(file) === name ? file : undefined;
}

// dotenv 16 unescapes nothing inside quotes and expands \n and \r inside double quotes, so a value
// is wrapped in a quote character it does not contain; undefined when none fits.
function quote(v: string): string | undefined {
  if (/[\r\n\0]/.test(v)) return undefined;
  const q = ["'", "`", '"'].find((q) => !v.includes(q) && !(q === '"' && /\\[nr]/.test(v)));
  return q && q + v + q;
}

// Every line that sets a key (dotenv reads `KEY=`, `export KEY=` and `KEY:`, the last one wins) gets
// the new value; a key not there yet is appended. Other lines and the file's line endings stay.
function updated(text: string, values: [string, string][]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  for (const [key, v] of values) {
    const sets = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*[=:]`);
    let found = false;
    for (let i = 0; i < lines.length; i++) if (sets.test(lines[i])) (lines[i] = `${key}=${quote(v)}`), (found = true);
    if (!found) lines.push(`${key}=${quote(v)}`);
  }
  return lines.join(eol) + eol;
}

// One raw-mode reader for every prompt: Enter ends, Backspace edits, Ctrl-C cancels; characters
// pasted past an Enter wait for the next prompt. Raw mode is off again whenever a prompt ends.
function reader(input: Input, out: Write) {
  let pending = "";
  input.setEncoding("utf8");
  return (question: string, hidden = false) =>
    new Promise<string>((done, fail) => {
      let value = "";
      let over = false;
      const finish = (error?: Error) => {
        over = true;
        input.off("data", onData);
        input.off("end", onEnd);
        input.setRawMode!(false);
        input.pause();
        out("\n");
        if (error) fail(error);
        else done(value);
      };
      const feed = () => {
        const chars = [...pending];
        pending = "";
        for (let i = 0; i < chars.length; i++) {
          const ch = chars[i];
          if (ch === "\r" || ch === "\n") {
            pending = chars.slice(i + (ch === "\r" && chars[i + 1] === "\n" ? 2 : 1)).join("");
            return finish();
          }
          if (ch === "\u0003") return finish(new Cancelled());
          if (ch === "\u007f" || ch === "\b") {
            if (value) (value = [...value].slice(0, -1).join("")), hidden || out("\b \b");
          } else if (ch >= " ") (value += ch), hidden || out(ch);
        }
      };
      // shortcut: an escape sequence (arrow keys) is dropped whole, never used to edit; fine for one-line answers.
      const onData = (chunk: string) => {
        if (!chunk.startsWith("\u001b")) (pending += chunk), feed();
      };
      const onEnd = () => finish(new Cancelled());
      out(question);
      input.on("data", onData);
      input.once("end", onEnd);
      feed();
      if (over) return;
      if (input.readableEnded) return finish(new Cancelled());
      input.setRawMode!(true);
      input.resume();
    });
}

const realDeps = (): SetupDeps => ({
  input: process.stdin,
  out: (t) => void process.stdout.write(t),
  err: (t) => void process.stderr.write(t),
  connect: (env) => new MapepireBackend(loadProfile(env)),
});

export async function setupCli(args: string[], deps: SetupDeps = realDeps()): Promise<number> {
  const { input, out, err } = deps;
  if (args.length > 1) return err(USAGE), 2;
  const name = args[0] ?? "default";
  const file = fileFor(name);
  if (!file) {
    err(`"${name}" cannot be a profile name: use letters, digits, ".", "_" and "-", starting with a letter or digit; not "example", no "..", not ending ".bak" or ".orig"\n`);
    return 2;
  }
  if (!input.isTTY || !input.setRawMode) {
    err("setup reads the password without showing it, so it needs a real terminal: run it yourself in PowerShell, Windows Terminal, Terminal or a Linux shell, not through Claude, a pipe or Git Bash. Nothing was written.\n");
    return 2;
  }

  const [dir, ...later] = CONFIG_DIRS();
  const path = join(dir, file);
  // On a case-insensitive file system `Prod` would open `.env.prod`, another server's file.
  if (existsSync(path) && !readdirSync(dir).includes(file)) {
    err(`another profile in ${dir} differs from "${name}" only in case; use its exact name. Nothing was written.\n`);
    return 2;
  }
  const old = existsSync(path) ? readFileSync(path, "utf8") : "";
  const cur = parseProfile(old);
  out(`${old ? "updating" : "creating"} ${path}\n`);
  const shadowed = later.map((d) => join(d, file)).find((p) => existsSync(p));
  if (shadowed) out(`note: ${shadowed} also defines "${name}"; the file above takes precedence and nothing is copied from it\n`);

  let password = "";
  const values: [string, string][] = [];
  try {
    const ask = reader(input, out);
    const required = async (q: string, current?: string) => {
      for (;;) {
        const v = (await ask(current ? `${q} [${current}]: ` : `${q}: `)).trim() || current;
        if (v) return v;
      }
    };
    values.push(["IBMI_HOST", await required("IBM i host", cur.IBMI_HOST)]);
    values.push(["IBMI_USER", await required("IBM i user", cur.IBMI_USER)]);
    while (!password) password = (await ask(cur.IBMI_PASSWORD ? "password (Enter keeps the current one): " : "password: ", true)) || cur.IBMI_PASSWORD || "";
    values.push(["IBMI_PASSWORD", password]);
    const policy = (await ask(`policy file, absolute or relative to here (Enter leaves it ${cur.IBMI_KIT_POLICY ? `as ${cur.IBMI_KIT_POLICY}` : "unset"}): `)).trim();
    if (policy) values.push(["IBMI_KIT_POLICY", resolve(policy)]);
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    err("cancelled, nothing written\n");
    return 130;
  }

  // Prove the new text reads back as meant, every other setting included, before it touches the disk.
  const bad = values.find(([, v]) => quote(v) === undefined)?.[0];
  if (bad) {
    err(`${bad} cannot be written safely in a profile file (it holds a line break, or all three of ' " and \`). Nothing was written.\n`);
    return 2;
  }
  const next = updated(old, values);
  const want: Record<string, string> = { ...cur, ...Object.fromEntries(values) };
  const after = parseProfile(next);
  const drift = [...new Set([...Object.keys(want), ...Object.keys(after)])].find((k) => want[k] !== after[k]);
  if (drift) {
    err(`${drift} would not read back unchanged after the update, so ${path} was left as it was. Edit it by hand.\n`);
    return 2;
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `setup-${process.pid}-${randomBytes(4).toString("hex")}.tmp`); // never `.env.*`, so never listed
  try {
    writeFileSync(tmp, next, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    err(`cannot write ${path}: ${message(e)}\n`);
    return 2;
  }
  out(`saved ${path}\n`);

  // The test reads the file back, never the answers held here. The password is cut from any error text.
  const scrub = (t: string) => [password, JSON.stringify(password).slice(1, -1), encodeURIComponent(password)].reduce((s, p) => s.split(p).join("***"), t);
  let probe: Probe | undefined;
  try {
    const env = resolveProfileEnv(name);
    if (!listServers().includes(name)) throw new Error(`"${name}" is not among the listed servers`);
    const policy = env.IBMI_KIT_POLICY?.trim();
    if (policy) {
      if (!isAbsolute(policy)) throw new Error(`IBMI_KIT_POLICY must be an absolute path, not ${policy}`);
      loadPolicy(policy); // a bad policy would stop the server at startup
    }
    probe = deps.connect(env);
    const [row] = (await probe.query(SETUP_SQL)).rows;
    const [user, rdb] = Object.values(row ?? {}).map((v) => String(v).trim());
    out(`OK: ${name} signs on as ${user} to ${rdb}\n`);
    return 0;
  } catch (e) {
    out(`failed: ${scrub(message(e))}\n`);
    return 1;
  } finally {
    await probe?.close().catch(() => {});
  }
}
