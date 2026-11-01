// `ibmi-agent-kit setup [name]`: writes or updates one profile file from a terminal, then tests it
// by reading the file back and connecting. Returns the exit code: 0 OK, 1 the test failed (the file
// stays written), 2 a usage error or refusal (nothing written), 130 cancelled (nothing written).
// Run in a company config repo (policy.yaml and profiles/ in the current folder), it takes the
// settings from the chosen profiles/.env.<partition> skeleton and the repo's policy path.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIRS, parseProfile, resolveProfileEnv, serverName } from "@ibmi-agent-kit/core";
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
  cwd?: string; // default process.cwd()
}

const USAGE = "usage: ibmi-agent-kit setup [name]\n";
export const SETUP_SQL = "SELECT CURRENT USER, CURRENT SERVER FROM SYSIBM.SYSDUMMY1";
class Cancelled extends Error {}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
// The kit checkout this file runs from: <kit>/packages/server/dist/setup-cli.js.
// shortcut: assumes a checkout, wrong under an npm install; revisit when the kit is published (T-54).
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// A path with its symlinks resolved, through its nearest existing folder when it does not exist yet,
// so a folder or profile linked into the repo counts as inside it.
const real = (p: string): string => (existsSync(p) ? realpathSync(p) : dirname(p) === p ? p : join(real(dirname(p)), basename(p)));
// A folder's identity, so another spelling of it (case on macOS, a Windows 8.3 or subst path) still matches.
const id = (p: string) => {
  const s = statSync(p, { bigint: true, throwIfNoEntry: false });
  return s?.ino ? `${s.dev}:${s.ino}` : undefined; // some file systems report no inode
};
const within = (root: string, p: string) => {
  const r = relative(root, p);
  if (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)) return true;
  const want = id(root);
  for (let a = p; want; a = dirname(a)) {
    if (id(a) === want) return true;
    if (dirname(a) === a) return false;
  }
  return false;
};
// Settings a skeleton never supplies: the person's own sign-on and the policy path setup writes.
const OWN = new Set(["IBMI_USER", "IBMI_PASSWORD", "IBMI_KIT_POLICY"]);

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
    const sets = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/\./g, "\\.")}\\s*[=:]`); // a skeleton key may hold a dot
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
  const cwd = resolve(deps.cwd ?? process.cwd());
  if (args.length > 1) return err(USAGE), 2;
  const [dir, ...later] = CONFIG_DIRS();

  // Company-repo mode: policy.yaml and profiles/ in the current folder; folders above are not searched.
  const skeletons = join(cwd, "profiles");
  const repo = isFile(join(cwd, "policy.yaml")) && (statSync(skeletons, { throwIfNoEntry: false })?.isDirectory() ?? false);
  let partitions: string[] = [];
  if (repo) {
    partitions = readdirSync(skeletons, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => serverName(d.name))
      .filter((n): n is string => n !== undefined && fileFor(n) !== undefined)
      .sort();
    if (!partitions.length) return err(`the company config repo ${cwd} has no profile skeleton (profiles/.env.<partition>). Nothing was written.\n`), 2;
    if (args[0] !== undefined && !partitions.includes(args[0])) {
      return err(`"${args[0]}" is not a partition of the company config repo ${cwd}; its partitions: ${partitions.join(", ")}. Nothing was written.\n`), 2;
    }
    // The password goes only in the profile folder, so that folder, or a profile linked elsewhere, must not lie in the repo.
    const root = real(cwd);
    const leak = [dir, ...partitions.map((p) => join(dir, fileFor(p)!))].find((p) => within(root, real(p)));
    if (leak) {
      return err(`${leak} lies inside the company config repo ${cwd}, so setup would write your password into the repo. Use a profile folder outside it (IBMI_KIT_CONFIG_DIR) and no profile linked into it. Nothing was written.\n`), 2;
    }
  }
  if (args[0] !== undefined && !fileFor(args[0])) {
    err(`"${args[0]}" cannot be a profile name: use letters, digits, ".", "_" and "-", starting with a letter or digit; not "example", no "..", not ending ".bak" or ".orig"\n`);
    return 2;
  }
  // "" in a company repo with several partitions: asked below.
  let name = args[0] ?? (!repo ? "default" : partitions.length === 1 ? partitions[0] : "");
  if (!input.isTTY || !input.setRawMode) {
    err("setup reads the password without showing it, so it needs a real terminal: run it yourself in PowerShell, Windows Terminal, Terminal or a Linux shell, not through Claude, a pipe or Git Bash. Nothing was written.\n");
    return 2;
  }

  const ask = reader(input, out);
  const cancelled = (e: unknown) => {
    if (!(e instanceof Cancelled)) throw e;
    err("cancelled, nothing written\n");
    return 130;
  };
  let skeleton: Record<string, string> = {};
  if (repo) {
    out(`company config repo: ${cwd}\n`);
    const mcp = join(cwd, ".mcp.json");
    if (!process.env.IBMI_KIT_HOME && isFile(mcp) && readFileSync(mcp, "utf8").includes("${IBMI_KIT_HOME}")) {
      out(`this repo's .mcp.json starts the kit from IBMI_KIT_HOME, which is not set: set it to ${KIT} for your user, then open a new terminal before you run claude.\n`);
    }
    if (!name) {
      out(partitions.map((p, i) => `  ${i + 1}. ${p}\n`).join(""));
      try {
        while (!name) {
          const a = (await ask("partition (number or name): ")).trim();
          name = partitions.includes(a) ? a : (partitions[Number(a) - 1] ?? "");
        }
      } catch (e) {
        return cancelled(e);
      }
    }
    const from = join(skeletons, fileFor(name)!);
    skeleton = parseProfile(readFileSync(from, "utf8"));
    const missing = ["IBMI_HOST", "IBMI_PARTITION"].filter((k) => !skeleton[k]?.trim());
    if (missing.length) return err(`${from} sets no ${missing.join(" and no ")}. Nothing was written.\n`), 2;
    if (skeleton.IBMI_PASSWORD) err(`warning: ${from} holds a password. It is ignored, never copied: remove it from the repo and its git history, and change that password.\n`);
  }

  const file = fileFor(name)!;
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
  if (shadowed) out(`note: ${shadowed} also defines "${name}"; the file above takes precedence and nothing is copied from it, so its other settings, guards like IBMI_READ_ONLY, IBMI_KIT_POLICY and IBMI_BLOCKED_CL included, stop applying to "${name}". Ctrl-C now to stop.\n`);

  const repoPolicy = repo ? join(cwd, "policy.yaml") : undefined;
  if (repoPolicy && cur.IBMI_KIT_POLICY && cur.IBMI_KIT_POLICY !== repoPolicy) out(`IBMI_KIT_POLICY ${cur.IBMI_KIT_POLICY} is replaced by ${repoPolicy}\n`);
  // The current password belongs to the current host: on another host it is asked again, never kept.
  let keep: string | undefined = cur.IBMI_PASSWORD;
  if (repo) {
    out(`partition ${skeleton.IBMI_PARTITION} on host ${skeleton.IBMI_HOST}\n`);
    if (cur.IBMI_HOST !== skeleton.IBMI_HOST) {
      keep = undefined;
      if (cur.IBMI_HOST) out(`IBMI_HOST ${cur.IBMI_HOST} is replaced by ${skeleton.IBMI_HOST}\n`);
    }
  }

  let password = "";
  const values: [string, string][] = [];
  try {
    const required = async (q: string, current?: string) => {
      for (;;) {
        const v = (await ask(current ? `${q} [${current}]: ` : `${q}: `)).trim() || current;
        if (v) return v;
      }
    };
    // In a company repo the skeleton's settings (host, partition, transport, ports, guards) are the company's.
    if (repo) values.push(...Object.entries(skeleton).filter(([k]) => !OWN.has(k)));
    else values.push(["IBMI_HOST", await required("IBM i host", cur.IBMI_HOST)]);
    values.push(["IBMI_USER", await required("IBM i user", cur.IBMI_USER)]);
    while (!password) password = (await ask(keep ? "password (Enter keeps the current one): " : "password: ", true)) || keep || "";
    values.push(["IBMI_PASSWORD", password]);
    if (repoPolicy) values.push(["IBMI_KIT_POLICY", repoPolicy]);
    else {
      // One pair of surrounding quotes (Windows "Copy as path") is dropped and a leading ~ expands.
      const policy = (await ask(`policy file, absolute or relative to here (Enter leaves it ${cur.IBMI_KIT_POLICY ? `as ${cur.IBMI_KIT_POLICY}` : "unset"}): `)).trim().replace(/^(["'])(.*)\1$/, "$2");
      if (policy) values.push(["IBMI_KIT_POLICY", resolve(cwd, /^~(?=[\\/]|$)/.test(policy) ? homedir() + policy.slice(1) : policy)]);
    }
  } catch (e) {
    return cancelled(e);
  }

  // A bad policy stops the server for every profile at startup, so it is checked before the write.
  const policyPath = values.find(([k]) => k === "IBMI_KIT_POLICY")?.[1];
  if (policyPath) {
    try {
      loadPolicy(policyPath);
    } catch (e) {
      err(`IBMI_KIT_POLICY ${policyPath}: ${message(e)}. Nothing was written.\n`);
      return 2;
    }
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
  // A symlinked profile is written through, so the link survives the rename.
  const target = existsSync(path) ? realpathSync(path) : path;
  const tmp = join(dirname(target), `setup-${process.pid}-${randomBytes(4).toString("hex")}.tmp`); // never `.env.*`, so never listed
  try {
    writeFileSync(tmp, next, { flag: "wx", mode: 0o600 });
    renameSync(tmp, target);
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
    const policy = env.IBMI_KIT_POLICY?.trim();
    if (policy) {
      if (!isAbsolute(policy)) throw new Error(`IBMI_KIT_POLICY must be an absolute path, not ${policy}`);
      loadPolicy(policy); // a policy kept from the old file may be bad; it would stop the server at startup
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
