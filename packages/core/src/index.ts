import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "dotenv";
import { signOnPageInstalled } from "./credential.js";

// The parser every profile file is read with, so a writer can prove its text reads back as meant.
export const parseProfile = (text: string): Record<string, string> => parse(text);

// Evaluated per call, not at import, so a changed environment or home folder is honoured.
// First match wins. Exactly these folders; the old per-engine folders are not read.
export function CONFIG_DIRS(): string[] {
  const home = homedir();
  return [
    process.env.IBMI_KIT_CONFIG_DIR || process.env.IBMI_MCP_CONFIG_DIR,
    join(home, ".ibmi-agent-kit"),
    join(home, ".ibm-i-servers"),
  ]
    .filter((d): d is string => Boolean(d))
    .map((d) => resolve(d));
}

// `.env` is "default", `.env.<name>` is "<name>". Never a server: `.env.example`; `.env.default`
// (the default is `.env`, and one name must mean one file); `.env.` with no name; editor and
// backup leftovers ending `.bak`, `.orig` or `~`; anything that is not a regular file.
export function serverName(file: string): string | undefined {
  if (file === ".env") return "default";
  if (!file.startsWith(".env.")) return undefined;
  const name = file.slice(5);
  if (!name || name === "example" || name === "default" || /(\.bak|\.orig|~)$/.test(name)) return undefined;
  return name;
}

// Each name with the directory entry it came from, first folder wins. The path is that entry,
// never rebuilt from the name, so on a case-insensitive file system `prod` cannot open `.env.Prod`.
function profiles(): Map<string, string> {
  const found = new Map<string, string>();
  for (const d of CONFIG_DIRS()) {
    let files: string[] = [];
    try {
      files = readdirSync(d);
    } catch {
      continue;
    }
    for (const f of files) {
      const name = serverName(f);
      if (name === undefined || found.has(name)) continue;
      try {
        if (statSync(join(d, f)).isFile()) found.set(name, join(d, f));
      } catch {
        // a dangling link, or removed while listing: not a server
      }
    }
  }
  return found;
}

export function listServers(): string[] {
  return [...profiles().keys()].sort();
}

// Settings that pick the box, the credentials, the transport (and the jar and certificate it
// trusts), a guard, or the verbs that run under it. These come from the profile file only, so a
// registration's environment can never lift a guard.
const PROTECTED =
  /^IBMI_(HOST|USER|PASSWORD|PASSWORD_COMMAND|PASSWORD_STORE|PARTITION|KIT_POLICY|KIT_VERBS|SQL_TRANSPORT|RESTRICTED|ALLOWED_CL|BLOCKED_CL|BLOCKED_TABLES|READ_ONLY|5250_TLS_INSECURE|MAPEPIRE_CA|MAPEPIRE_JAR|[A-Z0-9_]*_PORT)$/;

// Resolve a server name to the env map the engines' loadProfile() parses. The name is matched
// exactly against the listed names before any file is read, so it never becomes part of a path.
// One file supplies the whole profile; process.env is read, never written.
export function resolveProfileEnv(name?: string): Record<string, string> {
  const server = name || "default";
  const found = profiles();
  const path = found.get(server);
  if (path === undefined) {
    // The page is the one way to a first profile, so the error says where the offer is (only while it is installed).
    const hint = found.size === 0 && signOnPageInstalled() ? "; list_servers offers a setup page" : "";
    throw new Error(`unknown server "${server}". Available: ${[...found.keys()].sort().join(", ") || "none"}${hint}`);
  }
  // Only IBMI_* settings fall back to the environment; everything else in it is not ours.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k.startsWith("IBMI_") && !PROTECTED.test(k)) env[k] = v;
  }
  // Assigned last, so no profile line or environment value can spoof where the file is.
  return { ...env, ...parseProfile(readFileSync(path, "utf8")), IBMI_KIT_PROFILE_FILE: path };
}

export * from "./credential.js";

export interface Msg {
  id?: string;
  text: string;
}

// One way to send SQL and CL to an IBM i, whatever the connection. Types only; the Mapepire
// implementations live in the source engine.
export interface SqlTransport {
  query(
    sql: string,
    params?: unknown[],
    maxRows?: number,
  ): Promise<{ rows: unknown[]; columns: unknown[]; truncated: boolean }>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; messages: Msg[] }>;
  cl(command: string): Promise<{ ok: boolean; messages: Msg[] }>;
  close(): Promise<void>;
}
