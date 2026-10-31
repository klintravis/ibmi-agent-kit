import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "dotenv";

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

// `.env` is "default", `.env.<name>` is "<name>", `.env.example` is never a server.
export function listServers(): string[] {
  const names = new Set<string>();
  for (const d of CONFIG_DIRS()) {
    let files: string[] = [];
    try {
      files = readdirSync(d);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f === ".env") names.add("default");
      else if (f.startsWith(".env.") && f !== ".env.example") names.add(f.slice(5));
    }
  }
  return [...names].sort();
}

// Settings that pick the box, the credentials, the transport or a guard. These come from the
// profile file only, so a registration's environment can never lift a guard.
const PROTECTED =
  /^IBMI_(HOST|USER|PASSWORD|SQL_TRANSPORT|RESTRICTED|ALLOWED_CL|BLOCKED_CL|BLOCKED_TABLES|READ_ONLY|5250_TLS_INSECURE|[A-Z0-9_]*_PORT)$/;

// Resolve a server name to the env map the engines' loadProfile() parses. The name is matched
// exactly against listServers() before any file is read, so it never becomes part of a path
// unchecked. One file supplies the whole profile; process.env is read, never written.
export function resolveProfileEnv(name?: string): Record<string, string> {
  const server = name || "default";
  const available = listServers();
  if (!available.includes(server)) {
    throw new Error(`unknown server "${server}". Available: ${available.join(", ") || "none"}`);
  }
  const file = server === "default" ? ".env" : `.env.${server}`;
  const path = CONFIG_DIRS().map((d) => join(d, file)).find((p) => existsSync(p))!;
  // Only IBMI_* settings fall back to the environment; everything else in it is not ours.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k.startsWith("IBMI_") && !PROTECTED.test(k)) env[k] = v;
  }
  return { ...env, ...parse(readFileSync(path)) };
}

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
