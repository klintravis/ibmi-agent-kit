import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIG_DIRS, listServers, resolveProfileEnv } from "@ibmi-agent-kit/core";
import { loadPolicy, RunLog, type Policy } from "@ibmi-agent-kit/guard";
import { CONFIRM_TIMEOUT_MS, registerGuarded, type GuardDeps } from "./guarded.js";
import { KEYS, register as registerScreen } from "@ibmi-agent-kit/screen/tools";
import { register as registerSource, SQL_TIME_LIMIT_MS, type MapepireBackend } from "@ibmi-agent-kit/source/tools";
import { registerVerbTools, verbLoader } from "./verbs.js";

export interface Engine {
  shutdown(): Promise<void>;
}

export interface KitServer {
  mcp: McpServer;
  engines: Engine[];
}

export interface ServerDeps extends Partial<Omit<GuardDeps, "policyFor">> {
  extra?: (mcp: McpServer) => void;
  policy?: Policy; // every server decides with this one instead of its profile's IBMI_KIT_POLICY
  runLogDir?: string;
  sourceBackend?: (server?: string) => MapepireBackend; // the source engine's connection, for a stub transport
}

// No process state is touched here: no listeners, no exit, no stdout. index.ts owns the process.
// A tool name two engines both register throws the SDK's "Tool <name> is already registered".
// The policy comes from each profile's IBMI_KIT_POLICY (the profile file only, like every guard
// setting), each file loaded once: every listed profile's at startup, so a missing or invalid
// file throws and index.ts refuses to start naming it; a profile added later on first use. Unset,
// the built-in observe policy applies.
export function createServer(deps: ServerDeps = {}): KitServer {
  const mcp = new McpServer({ name: "ibmi-agent-kit", version: "0.1.0" }, { capabilities: { logging: {} } });
  const screen = registerScreen(mcp, { listServers: false });
  // The guard is registered below, once the source engine's connections exist; calls come later.
  let guard: ReturnType<typeof registerGuarded> | undefined;
  const source = registerSource(mcp, { listServers: false, guard: (tool, input, server) => guard!.tool(tool, input, server), newBackend: deps.sourceBackend });
  deps.extra?.(mcp);

  const notice = deps.notice ?? ((m: string) => console.error(m));
  const profileEnv = deps.profileEnv ?? ((server: string) => resolveProfileEnv(server));
  const runLogDir = deps.runLogDir ?? join(CONFIG_DIRS()[0], "runs");
  const loaded = new Map<string, { policy: Policy; runLog: RunLog }>();
  const policyFor = (server: string) => {
    const path = deps.policy ? "" : (profileEnv(server).IBMI_KIT_POLICY?.trim() ?? "");
    let entry = loaded.get(path);
    if (!entry) {
      // A relative path would depend on the client's working folder.
      if (path && !isAbsolute(path)) throw new Error(`profile ${server}: IBMI_KIT_POLICY must be an absolute path, not ${path}`);
      const policy = deps.policy ?? loadPolicy(path || undefined);
      for (const w of policy.warnings) notice(`[ibmi-agent-kit] policy warning: ${w}`);
      entry = { policy, runLog: new RunLog(runLogDir, policy, notice) };
      loaded.set(path, entry);
    }
    return entry;
  };
  if (!deps.policy) for (const server of listServers()) policyFor(server);

  const verbs = deps.verbs ?? verbLoader(profileEnv);
  guard = registerGuarded(mcp, {
    policyFor,
    conn: deps.conn ?? ((server) => source.backend(server)),
    memberText: deps.memberText ?? (async (server, ref) => (await source.backend(server).readMember(ref)).content),
    profileEnv,
    systemName: deps.systemName ?? (() => undefined), // group 6: the screen engine's sign-on System field
    confirmTimeoutMs: deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS,
    sqlTimeLimitMs: deps.sqlTimeLimitMs ?? SQL_TIME_LIMIT_MS,
    notice,
    verbs,
  });
  registerVerbTools(mcp, { verbs, context: guard.verbContext });

  mcp.registerTool(
    "list_servers",
    {
      title: "List servers",
      description:
        "List the configured IBM i servers, named by the .env.<name> files on disk, and the open 5250 sessions on each. Pass a name as `server` to any tool.",
      annotations: { title: "List servers", readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text" as const, text: listServersText(screen.openSessions()) }] }),
  );

  return { mcp, engines: [screen, source] };
}

export function listServersText(open: { server: string; session: string; closed?: boolean }[]): string {
  const servers = listServers();
  // A session whose profile file has since gone is still open, so it is still listed.
  const names = [...new Set([...servers, ...open.map((o) => o.server)])];
  const perServer = names
    .map((s) => {
      const sessions = open.filter((o) => o.server === s).map((o) => `${o.session}${o.closed ? " (closed)" : ""}`);
      return `  ${s}${servers.includes(s) ? "" : " (no profile)"}: ${sessions.join(", ") || "none"}`;
    })
    .join("\n");
  const dirs = CONFIG_DIRS()
    .map((d, i) => `  ${i + 1}. ${d}${existsSync(d) ? "" : "  (does not exist)"}`)
    .join("\n");
  return (
    `Servers: ${servers.join(", ") || "none configured"}\n` +
    (names.length ? `Open 5250 sessions:\n${perServer}\n` : "") +
    `\nProfiles are read from these folders, first match wins:\n${dirs}\n` +
    (servers.length ? "" : `\nNo profiles found. Copy .env.example as .env or .env.<name> into one of the folders above.\n`) +
    `\nKeys: ${KEYS.join(", ")}`
  );
}

// Every engine's shutdown at once, bounded in total. allSettled, so one engine failing does not
// cut another's sign off short. The timer is cleared rather than unref'd, so a hung engine still
// keeps the process alive until the bound is reached.
export async function shutdownAll(engines: Engine[], timeoutMs = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(engines.map((e) => Promise.resolve().then(() => e.shutdown()))),
    new Promise<void>((done) => (timer = setTimeout(done, timeoutMs))),
  ]);
  clearTimeout(timer);
}

// Runs the shutdown once, however many triggers fire, then calls exit(0).
export function onceShutdown(
  engines: Engine[],
  exit: (code: number) => void,
  timeoutMs = 5000,
): (reason: string) => Promise<void> {
  let running: Promise<void> | undefined;
  return (reason) =>
    (running ??= (async () => {
      console.error(`[ibmi-agent-kit] shutting down (${reason})`);
      await shutdownAll(engines, timeoutMs);
      exit(0);
    })());
}
