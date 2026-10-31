// Modified by ibmi-agent-kit (2026): profiles resolve through @ibmi-agent-kit/core, no .env is loaded into process.env; adds IBMI_SQL_TRANSPORT and IBMI_MAPEPIRE_PORT.
import { listServers, resolveProfileEnv } from "@ibmi-agent-kit/core";
import type { Profile } from "./types.js";

// --- servers ---
// core owns the folders and the exact-name check, so a name never reaches a path unchecked
export { listServers };

export function loadProfileFor(server?: string): Profile {
  return loadProfile(resolveProfileEnv(server));
}

// --- profile ---
// fails closed: IBMI_READ_ONLY is a safety flag, so anything set that is not an explicit off
// counts as on. "true " and "y" used to read as false and quietly unlock upload and compile.
const bool = (v: string | undefined, dflt: boolean) => {
  const t = v?.trim().toLowerCase();
  return !t ? dflt : !/^(0|false|no|off)$/.test(t);
};
const list = (v: string | undefined) => (v ? v.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean) : []);
const TRANSPORTS = ["ssh", "daemon"] as const;

function transport(v: string | undefined): Profile["sqlTransport"] {
  const t = (v?.trim().toLowerCase() || "ssh") as Profile["sqlTransport"];
  if (!TRANSPORTS.includes(t)) throw new Error(`IBMI_SQL_TRANSPORT must be ${TRANSPORTS.join(" or ")}, got "${v}"`);
  return t;
}

export function loadProfile(env: Record<string, string | undefined>): Profile {
  const { IBMI_HOST: host, IBMI_USER: user, IBMI_PASSWORD: password } = env;
  if (!host || !user || !password) throw new Error("missing IBMI_HOST, IBMI_USER and/or IBMI_PASSWORD in the env file");
  return {
    host, user, password,
    sshPort: Number(env.IBMI_SSH_PORT || 22),
    sqlTransport: transport(env.IBMI_SQL_TRANSPORT),
    mapepirePort: Number(env.IBMI_MAPEPIRE_PORT || 8076),
    sourceFileCcsid: Number(env.IBMI_SOURCE_FILE_CCSID || 37),
    mapepireJar: env.IBMI_MAPEPIRE_JAR || undefined,
    readOnly: bool(env.IBMI_READ_ONLY, false),
    blockedCl: list(env.IBMI_BLOCKED_CL),
    blockedTables: list(env.IBMI_BLOCKED_TABLES),
  };
}
