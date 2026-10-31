import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIG_DIRS, listServers } from "@ibmi-agent-kit/core";
import { KEYS, register as registerScreen } from "@ibmi-agent-kit/screen/tools";
import { register as registerSource } from "@ibmi-agent-kit/source/tools";

export interface Engine {
  shutdown(): Promise<void>;
}

export interface KitServer {
  mcp: McpServer;
  engines: Engine[];
}

// No process state is touched here: no listeners, no exit, no stdout. index.ts owns the process.
// A tool name two engines both register throws the SDK's "Tool <name> is already registered".
export function createServer(deps: { extra?: (mcp: McpServer) => void } = {}): KitServer {
  const mcp = new McpServer({ name: "ibmi-agent-kit", version: "0.1.0" }, { capabilities: { logging: {} } });
  const screen = registerScreen(mcp, { listServers: false });
  const source = registerSource(mcp, { listServers: false });
  deps.extra?.(mcp);

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
