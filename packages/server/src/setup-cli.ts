// `ibmi-agent-kit setup [name]`: writes or updates one profile file from a terminal, then tests it
// by reading the file back and connecting. Returns the exit code: 0 OK, 1 the test failed (the file
// stays written), 2 a usage error or refusal (nothing written), 130 cancelled (nothing written).
// Run in a company config repo (policy.yaml and profiles/ in the current folder), it takes the
// settings from the chosen profiles/.env.<partition> skeleton and the repo's policy path.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIRS, gitWorkTree, lastSecret, parseHelperCommand, parseProfile, resolveProfileEnv, setCredentialStore, type CredentialStore } from "@ibmi-agent-kit/core";
import { loadPolicy } from "@ibmi-agent-kit/guard";
import { loadProfile, MapepireBackend } from "@ibmi-agent-kit/source/tools";
import { companyRepo, fileFor, isFile, message, OWN, planProfile, policyError, readSkeleton, repoLeak, writeProfile } from "./profile-write.js";

export interface Input extends NodeJS.EventEmitter {
  isTTY?: boolean;
  readableEnded?: boolean;
  setRawMode?(on: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
}
export type Write = (text: string) => void;
export type Probe = { query(sql: string): Promise<{ rows: Record<string, unknown>[] }>; close(): Promise<void> };
export interface SetupDeps {
  input: Input;
  out: Write;
  err: Write;
  connect(env: Record<string, string>): Probe;
  cwd?: string; // default process.cwd()
  store?: CredentialStore; // default the OS store; the test connection reads through it too
}

const USAGE = "usage: ibmi-agent-kit setup [name]\n";
export const SETUP_SQL = "SELECT CURRENT USER, CURRENT SERVER FROM SYSIBM.SYSDUMMY1";
export class Cancelled extends Error {}
// The kit checkout this file runs from: <kit>/packages/server/dist/setup-cli.js.
// shortcut: assumes a checkout, wrong under an npm install; revisit when the kit is published (T-54).
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// One raw-mode reader for every prompt: Enter ends, Backspace edits, Ctrl-C cancels; characters
// pasted past an Enter wait for the next prompt. Raw mode is off again whenever a prompt ends.
export function reader(input: Input, out: Write) {
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
  if (deps.store) setCredentialStore(deps.store);
  const cwd = resolve(deps.cwd ?? process.cwd());
  if (args.length > 1) return err(USAGE), 2;
  const [dir, ...later] = CONFIG_DIRS();

  // Company-repo mode: policy.yaml and profiles/ in the current folder; folders above are not searched.
  const found = companyRepo(cwd);
  const repo = found !== undefined;
  const skeletons = found?.skeletons ?? "";
  const partitions = found?.partitions ?? [];
  if (repo) {
    if (!partitions.length) return err(`the company config repo ${cwd} has no profile skeleton (profiles/.env.<partition>). Nothing was written.\n`), 2;
    if (args[0] !== undefined && !partitions.includes(args[0])) {
      return err(`"${args[0]}" is not a partition of the company config repo ${cwd}; its partitions: ${partitions.join(", ")}. Nothing was written.\n`), 2;
    }
    // The profile (a helper command or store setting included) goes only in the profile folder, so that folder, or a profile linked elsewhere, must not lie in the repo.
    const leak = repoLeak(cwd, dir, partitions);
    if (leak) {
      return err(`${leak} lies inside the company config repo ${cwd}, so setup would write your profile, with its password source, into the repo. Use a profile folder outside it (IBMI_KIT_CONFIG_DIR) and no profile linked into it. Nothing was written.\n`), 2;
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
    const read = readSkeleton(skeletons, name);
    skeleton = read.skeleton;
    if (read.error) return err(`${read.error}. Nothing was written.\n`), 2;
    for (const w of read.warnings) err(w);
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
  if (repo) {
    out(`partition ${skeleton.IBMI_PARTITION} on host ${skeleton.IBMI_HOST}\n`);
  }

  // The password belongs to a user on a host. A new host or user never keeps the current source.
  let password = ""; // typed, or an old plain line being migrated; empty for a helper or a kept store entry
  let host = "";
  let user = "";
  let source: "store" | "helper" | "kept" = "store"; // kept: the current helper line stays as it is
  let command = "";
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
    host = values.find(([k]) => k === "IBMI_HOST")![1];
    if (host !== cur.IBMI_HOST && cur.IBMI_HOST) out(`IBMI_HOST ${cur.IBMI_HOST} is replaced by ${host}\n`);
    user = await required("IBM i user", cur.IBMI_USER);
    values.push(["IBMI_USER", user]);
    const same = host === cur.IBMI_HOST && user === cur.IBMI_USER;
    const curHelper = same ? cur.IBMI_PASSWORD_COMMAND : undefined;
    const curStore = same && !cur.IBMI_PASSWORD_COMMAND && cur.IBMI_PASSWORD_STORE === "os";
    const curPlain = same && !cur.IBMI_PASSWORD_COMMAND && !cur.IBMI_PASSWORD_STORE ? cur.IBMI_PASSWORD : undefined;
    const answer = (await ask(curHelper ? "password source (Enter keeps the current helper, os for the OS credential store, or another helper command): " : "password source (Enter for the OS credential store, or a helper command): ")).trim();
    if (!answer && curHelper) source = "kept";
    else if (!answer || answer.toLowerCase() === "os") source = "store";
    else (source = "helper"), (command = answer);
    if (source === "helper") {
      try {
        parseHelperCommand(command);
      } catch (e) {
        return err(`${message(e)}. Nothing was written.\n`), 2;
      }
      const tree = gitWorkTree(path);
      if (tree) {
        return err(`a password helper cannot be used for ${path}: it is inside the git work tree ${tree}, where a pulled change could add a command. Use the OS credential store (Enter at the source prompt), or a profile folder outside the work tree. Nothing was written.\n`), 2;
      }
    }
    if (source === "store") {
      for (;;) {
        const typed = await ask(curPlain || curStore ? "password (Enter keeps the current one): " : "password: ", true);
        if (typed) password = typed;
        else if (curPlain) password = curPlain; // migrated: stored below, its line removed
        else if (!curStore) continue; // an existing store entry stays as it is
        break;
      }
    }
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
  const badPolicy = policyPath && policyError(policyPath);
  if (badPolicy) {
    err(`${badPolicy}. Nothing was written.\n`);
    return 2;
  }

  // The chosen source is the only one left in the file; a plain password line never stays.
  const drop = ["IBMI_PASSWORD"];
  if (source === "store") (values.push(["IBMI_PASSWORD_STORE", "os"]), drop.push("IBMI_PASSWORD_COMMAND"));
  else if (source === "helper") (values.push(["IBMI_PASSWORD_COMMAND", command]), drop.push("IBMI_PASSWORD_STORE"));
  else drop.push("IBMI_PASSWORD_STORE");

  const plan = planProfile(old, cur, values, drop, path);
  if ("error" in plan) return err(`${plan.error}\n`), 2;
  const failed = await writeProfile({ dir, path, next: plan.next, user, host, password, store: source === "store" });
  if (failed) {
    err(failed.stored ? `${failed.error}\n` : `${failed.error}. Nothing was written.\n`);
    return 2;
  }
  out(`saved ${path}\n`);

  // The test reads the file back, never the answers held here. The typed password and whatever the
  // helper or store returned for the test are cut from any error text.
  const scrub = (t: string) =>
    [password, lastSecret(host, user)]
      .filter((s): s is string => !!s)
      .flatMap((s) => [s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s)])
      .reduce((s, p) => s.split(p).join("***"), t);
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
