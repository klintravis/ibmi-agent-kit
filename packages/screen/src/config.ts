// Modified by ibmi-agent-kit (2026): profiles now resolve through @ibmi-agent-kit/core, which also checks the name; the module-level dotenv loading is removed.
import { CONFIG_DIRS, listServers, resolveProfileEnv } from "@ibmi-agent-kit/core";
import { DEFAULT_CCSID } from "./ebcdic.js";
import type { Profile } from "./types.js";

export { CONFIG_DIRS, listServers };

// core owns the folders and the exact-name check, so both engines refuse a name the same way.
export function loadProfileFor(server?: string): Profile {
  return loadProfile(resolveProfileEnv(server));
}

// Unrecognised throws rather than reading as false, so a typo cannot quietly turn a setting off.
const bool = (v: string | undefined, dflt: boolean, name: string) => {
  if (v === undefined || v.trim() === "") return dflt;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name}="${v}" is neither true nor false. Use true or false.`);
};
// Bare verbs, so "MYLIB/STRAPP" would sit in the allowlist never matching anything.
const list = (v: string | undefined) =>
  v ? v.split(/[,\s]+/).map((s) => s.toLowerCase().split("/").pop()!).filter(Boolean) : [];
const num = (v: string | undefined, dflt: number) => {
  const n = Number(v?.trim());
  return v?.trim() && Number.isFinite(n) ? n : dflt;
};

export function loadProfile(env: NodeJS.ProcessEnv | Record<string, string> = process.env): Profile {
  const host = env.IBMI_HOST;
  const user = env.IBMI_USER;
  const password = env.IBMI_PASSWORD;
  if (!host || !user || !password) {
    throw new Error("missing IBMI_HOST, IBMI_USER and/or IBMI_PASSWORD in the env file");
  }

  // Not aliased to IBMI_RESTRICTED: the two mean different things.
  if (env.IBMI_READ_ONLY) {
    console.error(
      `[ibm-i-5250-mcp] warning: IBMI_READ_ONLY is set but does nothing here. Use IBMI_RESTRICTED ` +
        `for allowlist mode, or IBMI_BLOCKED_CL to name the verbs to refuse.`,
    );
  }

  // 992 is telnet over TLS and 23 is plain, so a separate flag could only contradict the port.
  const port = num(env.IBMI_5250_PORT, 23);

  // The host picks geometry per screen, so the larger device runs 24x80 programs too.
  const terminalType = env.IBMI_5250_TERMINAL || "IBM-3477-FC";
  const wide = /3477|-fc$/i.test(terminalType);

  return {
    host,
    user,
    password,
    port,
    tls: port === 992,
    tlsInsecure: bool(env.IBMI_5250_TLS_INSECURE, false, "IBMI_5250_TLS_INSECURE"),
    deviceName: env.IBMI_5250_DEVICE || undefined,
    terminalType,
    ccsid: num(env.IBMI_5250_CCSID, DEFAULT_CCSID),
    rows: wide ? 27 : 24,
    cols: wide ? 132 : 80,
    restricted: bool(env.IBMI_RESTRICTED, true, "IBMI_RESTRICTED"),
    allowedCl: list(env.IBMI_ALLOWED_CL),
    blockedCl: list(env.IBMI_BLOCKED_CL),
    viewerEnabled: bool(env.IBMI_5250_VIEWER, false, "IBMI_5250_VIEWER"),
    viewerPort: num(env.IBMI_5250_VIEWER_PORT, 5250),
    initialLibrary: env.IBMI_5250_CURLIB || undefined,
    initialProgram: env.IBMI_5250_PROGRAM || undefined,
    initialMenu: env.IBMI_5250_MENU || undefined,
  };
}
