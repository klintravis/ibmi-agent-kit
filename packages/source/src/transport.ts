import mapepire from "@ibm/mapepire-js";
import type { Msg, SqlTransport } from "@ibmi-agent-kit/core";
import { NOOP_REPORTER, type Profile, type Reporter, type SqlColumn } from "./types.js";
import { closeSshMapepire, connectSshMapepire, raceJobClosed } from "./sshMapepire.js";

const { SQLJob } = mapepire;
type Job = InstanceType<typeof SQLJob>;
type Row = Record<string, any>;

// --- constants ---
const MAX_ROWS = 100_000;

// --- types ---
// core's interface with the shapes this engine reads. cl also keeps the server's own error and
// sql state, so the failure texts the backend has always reported stay word for word.
export interface Transport extends SqlTransport {
  query(sql: string, params?: unknown[], maxRows?: number): Promise<{ rows: Row[]; columns: SqlColumn[]; truncated: boolean }>;
  cl(command: string): Promise<{ ok: boolean; messages: Msg[]; error?: string; sqlState?: string }>;
  connect(reporter?: Reporter): Promise<void>;
  onReconnect?: () => void; // a new job lost every job-scoped setting, e.g. the backend's ovrprtf
}

export type Connector = (profile: Profile, reporter: Reporter) => Promise<Job>;

// --- daemon ---
// an admin-installed Mapepire server: a websocket to IBMI_HOST:IBMI_MAPEPIRE_PORT, no ssh, no upload
export async function connectDaemonMapepire(profile: Profile, reporter: Reporter = NOOP_REPORTER): Promise<Job> {
  const hostKey = `${profile.host}:${profile.mapepirePort}`;
  reporter.step(`connecting to the mapepire server at ${hostKey} as ${profile.user}`);
  const job = new SQLJob({ naming: "system" }); // the jdbc driver would otherwise default to sql naming
  try {
    await job.connect({ host: profile.host, port: profile.mapepirePort, user: profile.user, password: profile.password });
  } catch (e: any) {
    throw new Error(`cannot connect to the mapepire server at ${hostKey}: ${e?.message || e}. Is it running (IBMI_SQL_TRANSPORT=daemon needs one on the box) and is IBMI_MAPEPIRE_PORT right?`);
  }
  // a clean websocket close leaves the job "ready" in mapepire-js, so mark it ended and the next call reconnects
  const j = job as any;
  j._closed = new Promise<never>((_, rej) => job.getSocket?.()?.once("close", () => {
    j.status = "ended";
    rej(new Error(`connection to ${profile.host} lost: the mapepire server closed it. The next call reconnects automatically.`));
  }));
  j._closed.catch(() => {}); // observed on demand via raceJobClosed
  reporter.log("info", `connected to ${hostKey} as ${profile.user} (mapepire daemon)`);
  return job;
}

// --- transport ---
export class MapepireTransport implements Transport {
  private job?: Job;
  private connecting?: Promise<Job>;
  onReconnect?: () => void;

  constructor(private profile: Profile, private open: Connector) {}

  async connect(reporter: Reporter = NOOP_REPORTER): Promise<void> {
    await this.live(reporter);
  }

  private async live(reporter: Reporter = NOOP_REPORTER): Promise<Job> {
    if (this.job && (this.job as any).status !== "ended") return this.job;
    if (!this.connecting) {
      if (this.job) {
        reporter.log("notice", `connection to ${this.profile.host} was lost, reconnecting`);
        this.job = undefined;
        this.onReconnect?.();
      }
      this.connecting = this.open(this.profile, reporter).finally(() => (this.connecting = undefined));
    }
    this.job = await this.connecting;
    return this.job;
  }

  async query(sql: string, params?: unknown[], maxRows = MAX_ROWS) {
    const job = await this.live();
    const q = (job as any).query(sql, params ? { parameters: params } : undefined);
    // one past the cap: is_done stays false when a result is exactly the cap, so it cannot tell truncation
    const rs: any = await raceJobClosed(job, q.execute(maxRows + 1));
    await q.close?.();
    const columns: SqlColumn[] = (rs.metadata?.columns ?? []).map((c: any) => ({ name: c.name, type: c.type, precision: c.precision, scale: c.scale }));
    const data: Row[] = rs.has_results ? rs.data : [];
    return { rows: data.slice(0, maxRows), columns, truncated: data.length > maxRows };
  }

  // the statement text goes as written and every value is bound, never spliced in
  async execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; messages: Msg[] }> {
    const job = await this.live();
    const q = (job as any).query(sql, params ? { parameters: params } : undefined);
    const rs: any = await raceJobClosed(job, q.execute());
    await q.close?.();
    return { rowsAffected: Number(rs.update_count ?? 0), messages: [] };
  }

  // a mapepire cl request runs the command through QSYS2.QCMDEXC on the server and returns the
  // job log entries it wrote, which carry the IBM i message ids
  async cl(command: string): Promise<{ ok: boolean; messages: Msg[]; error?: string; sqlState?: string }> {
    const job = await this.live();
    const q = (job as any).query(command, { isClCommand: true });
    const rs: any = await raceJobClosed(job, q.execute());
    await q.close?.();
    const messages: Msg[] = (rs?.joblog ?? []).map((m: any) => ({ id: m.MESSAGE_ID || undefined, text: String(m.MESSAGE_TEXT ?? "") }));
    if (!messages.length && rs?.error) messages.push({ text: String(rs.error) });
    return { ok: rs?.success !== false, messages, error: rs?.error, sqlState: rs?.sql_state };
  }

  async close(): Promise<void> {
    await closeSshMapepire(this.job); // ends the job, and the ssh session when there is one
    this.job = undefined;
  }
}

// IBMI_SQL_TRANSPORT picks how the job is reached; everything above it is the same
export function transportFor(profile: Profile): MapepireTransport {
  return new MapepireTransport(profile, profile.sqlTransport === "daemon" ? connectDaemonMapepire : connectSshMapepire);
}
