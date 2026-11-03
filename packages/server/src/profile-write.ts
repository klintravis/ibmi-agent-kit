// Profile writing shared by `setup` (terminal) and, later, the sign-on page: company repo detection,
// skeleton read, the leak check, policy load, the read-back check, store-first order and the atomic
// 600/700 write. Each step returns its refusal text and prints nothing; the caller decides how to report.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseProfile, serverName, storeSecret } from "@ibmi-agent-kit/core";
import { loadPolicy } from "@ibmi-agent-kit/guard";

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
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
export const OWN = new Set(["IBMI_USER", "IBMI_PASSWORD", "IBMI_PASSWORD_COMMAND", "IBMI_PASSWORD_STORE", "IBMI_KIT_POLICY"]);

// The file a name is written to: only names core lists as that server, from characters safe in a
// file name on every OS (Windows drops a trailing dot, so `x.` would never be listed as `x.`).
export function fileFor(name: string): string | undefined {
  const file = name === "default" ? ".env" : `.env.${name}`;
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..") && !name.endsWith(".");
  return safe && serverName(file) === name ? file : undefined;
}

// dotenv 16 unescapes nothing inside quotes and expands \n and \r inside double quotes, so a value
// is wrapped in a quote character it does not contain; undefined when none fits.
export function quote(v: string): string | undefined {
  if (/[\r\n\0]/.test(v)) return undefined;
  const q = ["'", "`", '"'].find((q) => !v.includes(q) && !(q === '"' && /\\[nr]/.test(v)));
  return q && q + v + q;
}

// Every line that sets a key (dotenv reads `KEY=`, `export KEY=` and `KEY:`, the last one wins) gets
// the new value; a key not there yet is appended. Other lines and the file's line endings stay.
// Keys in `drop` lose every line that sets them.
export function updated(text: string, values: [string, string][], drop: string[] = []): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let lines = text ? text.split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  const setting = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key.replace(/\./g, "\\.")}\\s*[=:]`); // a skeleton key may hold a dot
  for (const key of drop) lines = lines.filter((l) => !setting(key).test(l));
  for (const [key, v] of values) {
    const sets = setting(key);
    let found = false;
    for (let i = 0; i < lines.length; i++) if (sets.test(lines[i])) (lines[i] = `${key}=${quote(v)}`), (found = true);
    if (!found) lines.push(`${key}=${quote(v)}`);
  }
  return lines.join(eol) + eol;
}

// Company-repo mode: policy.yaml and profiles/ in the folder; folders above are not searched.
export function companyRepo(cwd: string): { skeletons: string; partitions: string[] } | undefined {
  const skeletons = join(cwd, "profiles");
  if (!(isFile(join(cwd, "policy.yaml")) && (statSync(skeletons, { throwIfNoEntry: false })?.isDirectory() ?? false))) return undefined;
  const partitions = readdirSync(skeletons, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => serverName(d.name))
    .filter((n): n is string => n !== undefined && fileFor(n) !== undefined)
    .sort();
  return { skeletons, partitions };
}

// The profile (a helper command or store setting included) goes only in the profile folder, so that
// folder, or a profile linked elsewhere, must not lie in the repo. Returns the offending path.
export function repoLeak(cwd: string, dir: string, partitions: string[]): string | undefined {
  const root = real(cwd);
  return [dir, ...partitions.map((p) => join(dir, fileFor(p)!))].find((p) => within(root, real(p)));
}

// The partition's skeleton with its checks: `error` is a refusal, `warnings` are printed and the run goes on.
export function readSkeleton(skeletons: string, name: string): { from: string; skeleton: Record<string, string>; error?: string; warnings: string[] } {
  const from = join(skeletons, fileFor(name)!);
  const skeleton = parseProfile(readFileSync(from, "utf8"));
  const missing = ["IBMI_HOST", "IBMI_PARTITION"].filter((k) => !skeleton[k]?.trim());
  const warnings: string[] = [];
  if (skeleton.IBMI_PASSWORD) warnings.push(`warning: ${from} holds a password. It is ignored, never copied: remove it from the repo and its git history, and change that password.\n`);
  if (skeleton.IBMI_PASSWORD_COMMAND) warnings.push(`warning: ${from} holds IBMI_PASSWORD_COMMAND. It is ignored, never copied or run: a command in a repo runs on every colleague's machine. Remove it from the repo.\n`);
  return { from, skeleton, error: missing.length ? `${from} sets no ${missing.join(" and no ")}` : undefined, warnings };
}

// A bad policy stops the server for every profile at startup, so it is checked before the write.
export function policyError(policyPath: string): string | undefined {
  try {
    loadPolicy(policyPath);
  } catch (e) {
    return `IBMI_KIT_POLICY ${policyPath}: ${message(e)}`;
  }
}

// Prove the new text reads back as meant, every other setting included, before it touches the disk.
export function planProfile(old: string, cur: Record<string, string>, values: [string, string][], drop: string[], path: string): { next: string } | { error: string } {
  const bad = values.find(([, v]) => quote(v) === undefined)?.[0];
  if (bad) return { error: `${bad} cannot be written safely in a profile file (it holds a line break, or all three of ' " and \`). Nothing was written.` };
  const next = updated(old, values, drop);
  const want: Record<string, string> = { ...cur, ...Object.fromEntries(values) };
  for (const k of drop) delete want[k];
  const after = parseProfile(next);
  const drift = [...new Set([...Object.keys(want), ...Object.keys(after)])].find((k) => want[k] !== after[k]);
  return drift ? { error: `${drift} would not read back unchanged after the update, so ${path} was left as it was. Edit it by hand.` } : { next };
}

// The store comes first: when it fails, the file stays as it was. Then the 700 folder and the 600
// file through a temp name and a rename. Returns the failure text; the caller adds "Nothing was written." where it applies.
export async function writeProfile(o: { dir: string; path: string; next: string; user: string; host: string; password: string; store: boolean }): Promise<{ error: string; stored: boolean } | undefined> {
  if (o.password && o.store) {
    try {
      await storeSecret(o.user, o.host, o.password);
    } catch (e) {
      return { error: message(e), stored: false };
    }
  }
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  // A symlinked profile is written through, so the link survives the rename.
  const target = existsSync(o.path) ? realpathSync(o.path) : o.path;
  const tmp = join(dirname(target), `setup-${process.pid}-${randomBytes(4).toString("hex")}.tmp`); // never `.env.*`, so never listed
  try {
    writeFileSync(tmp, o.next, { flag: "wx", mode: 0o600 });
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    return { error: `cannot write ${o.path}: ${message(e)}`, stored: true };
  }
}
