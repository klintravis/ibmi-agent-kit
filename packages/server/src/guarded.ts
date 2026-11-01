// The server's half of the execution guard (design D5-D7): who and where a connection is, the
// catalog lookups, `run_script`, `policy_check` and the confirmation, the same context for verbs
// (verbs.ts), and the engines' tool hooks (source tools, 5250 command lines and sign on). The guard package decides;
// this file does the I/O. Engines never write to stdout, and neither does this.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Msg } from "@ibmi-agent-kit/core";
import { assertNotRunaway, validName, withTimeLimit } from "@ibmi-agent-kit/source/tools";
import {
  classify,
  decide,
  decideStatements,
  detectPartition,
  loadPolicy,
  parseCl,
  recordLookups,
  runPolicyTests,
  stripClComments,
  type Answers,
  type ClassifiedStatement,
  type CommandEntry,
  type Decision,
  type Identity,
  type Lookups,
  type ObjectRef,
  type Operation,
  type PartitionNames,
  type Policy,
  type RunLog,
  type ToolStatement,
  type VerbSet,
} from "@ibmi-agent-kit/guard";
import { checkVerb, QUERY, verbCheckInput, type ConfirmItem, type VerbContext } from "./verbs.js";

// What the guard needs of a connection: the source engine's MapepireBackend fits, a stub does too.
// `generation` is the job the caller decided against: another job refuses before sending.
export interface Conn {
  profile: { user: string; password: string; readOnly: boolean; blockedTables: string[]; blockedCl: string[] };
  query(sql: string, params?: unknown[], maxRows?: number, reporter?: undefined, generation?: number): Promise<{ rows: Record<string, unknown>[]; columns: { name: string }[]; truncated: boolean }>;
  execute(sql: string, params?: unknown[], reporter?: undefined, generation?: number): Promise<{ rowsAffected: number; messages: Msg[] }>;
  cl(command: string, reporter?: undefined, generation?: number): Promise<{ ok: boolean; messages: Msg[] }>;
  close(): Promise<void>; // the reset after a time limit
  generation?: number; // bumped when the job is lost or reset
}

export interface GuardDeps {
  // The policy the server's profile names (IBMI_KIT_POLICY), loaded once, and its run log.
  policyFor(server: string): { policy: Policy; runLog: RunLog };
  conn(server: string): Conn;
  profileEnv(server: string): Record<string, string>; // the profile file, for IBMI_PARTITION
  systemName(server: string): string | undefined; // the 5250 sign-on System name, once a session read it
  confirmTimeoutMs: number;
  sqlTimeLimitMs: number; // run_script queries, as run_sql
  notice(message: string): void; // stderr
  verbs(server: string): VerbSet; // the server's verbs (project-verbs), for policy_check's verb input
  // A source member's text, for compile_member's SQL members and RUNSQLSTM (the source engine).
  memberText(server: string, ref: { library: string; sourceFile: string; member: string }): Promise<string>;
}

export const CONFIRM_TIMEOUT_MS = 120_000;

export const LIMITS =
  "The guard classifies only the text it is given: it does not see what called programs, triggers, application menu options or prompted fields do, and IBM i authority remains the real boundary.";
const ASK = "Ask the user how to proceed; do not try another route (another tool, a rewritten statement, QCMDEXC).";

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

// --- lookups (design D1) ---

// Catalog answers for the classifier, values always bound. Column names are unverified on a live
// box (group 8 checks them on PUB400).
export function sqlLookups(conn: Conn): Lookups {
  const rows = async (sql: string, params: unknown[]) => (await conn.query(sql, params, 1000)).rows;
  return {
    async systemSchema(schema) {
      const [r] = await rows("SELECT SYSTEM_SCHEMA_NAME AS S FROM QSYS2.SYSSCHEMAS WHERE SCHEMA_NAME = ?", [schema]);
      return str(r?.S) || undefined;
    },
    // Two queries, so a failure names the catalog; either failing throws and the classifier denies.
    async baseTables({ lib, name }) {
      const ask = (what: string, sql: string) =>
        rows(sql, [lib, name, name]).catch((e) => {
          throw new Error(`${what}: ${(e as Error).message}`);
        });
      const aliases = await ask("QSYS2.SYSTABLES", "SELECT BASE_TABLE_SCHEMA AS L, BASE_TABLE_NAME AS N FROM QSYS2.SYSTABLES WHERE TABLE_TYPE = 'A' AND SYSTEM_TABLE_SCHEMA = ? AND (TABLE_NAME = ? OR SYSTEM_TABLE_NAME = ?)");
      const views = await ask(
        "QSYS2.SYSVIEWDEP",
        "SELECT OBJECT_SCHEMA AS L, OBJECT_NAME AS N FROM QSYS2.SYSVIEWDEP WHERE SYSTEM_VIEW_SCHEMA = ? AND (VIEW_NAME = ? OR SYSTEM_VIEW_NAME = ?) AND OBJECT_TYPE NOT IN ('FUNCTION', 'TYPE')",
      );
      return [...aliases, ...views].map((r) => ({ lib: str(r.L), name: str(r.N) })).filter((b) => b.lib && b.name);
    },
    async currentLibrary() {
      const [r] = await rows("SELECT SYSTEM_SCHEMA_NAME AS S FROM QSYS2.LIBRARY_LIST_INFO WHERE TYPE = 'CURRENT'", []);
      return str(r?.S) || undefined;
    },
  };
}

// A 5250 command line runs in the 5250 job, whose current library and QTEMP the SQL job cannot
// see: *CURLIB is unqualified and a write through a QTEMP alias or view is danger.
function screenLookups(sql: Lookups): Lookups {
  return {
    ...sql,
    currentLibrary: async () => undefined,
    baseTables: async (o) => {
      if (o.lib === "QTEMP") throw new Error("the 5250 job's QTEMP is not visible to the guard");
      return sql.baseTables(o);
    },
  };
}

// After a confirmation, whose wait may be long: a *CURLIB decided before it must still be the
// current library. Why not, or undefined when it was not looked up or has not changed.
export async function curlibMoved(conn: Conn, answers: Answers): Promise<string | undefined> {
  if (!("curlib" in answers)) return undefined;
  const now = (await sqlLookups(conn).currentLibrary().catch(() => undefined)) ?? null;
  return now === (answers.curlib ?? null) ? undefined : `the current library changed from ${answers.curlib ?? "none"} to ${now ?? "unknown"} while confirming`;
}

// --- identity and partition, once per connection (design D5) ---

interface Box {
  user: string;
  rdb?: string;
  groups?: string[]; // absent: USER_INFO had no row or failed, so roles fall back to default_role
  authlists?: string[];
  notes: string[];
  failed?: boolean; // a lookup threw: this call decides with what was read, the next one asks again
}

// SUPPLEMENTAL_GROUP_LIST: ten-character slots (a full name runs into the next, the last may be
// trimmed), read as slots only when every padded slot is one name; otherwise blank-separated
// (unverified on a live box: tasks 8.2 checks it on PUB400).
export function supplementalGroups(list: string): string[] {
  const slots = list.padEnd(Math.ceil(list.length / 10) * 10).match(/.{10}/g) ?? [];
  return (slots.every((s) => /^\S+ *$/.test(s)) ? slots : list.split(/\s+/)).map((s) => s.trim()).filter(Boolean);
}

// These lookups are the kit's own and are not decided. When the first fails (a 5250-only profile
// with no working SQL connection, say), the profile's user decides with default_role (owner ruling
// 2026-10-31); danger and unqualified are denied in every mode regardless. Any of the three
// throwing sets `failed`, so the box is not cached; USER_INFO with no row is an answer.
async function readBox(conn: Conn): Promise<Box> {
  let me: Record<string, unknown> | undefined;
  try {
    [me] = (await conn.query("SELECT CURRENT SERVER AS RDB, CURRENT USER AS USR FROM SYSIBM.SYSDUMMY1")).rows;
  } catch (e) {
    const user = conn.profile.user.toUpperCase();
    return { user, failed: true, notes: [`identity lookup failed, so ${user} from the profile decides with default_role: ${(e as Error).message}`] };
  }
  const box: Box = { user: (str(me?.USR) || conn.profile.user).toUpperCase(), notes: [] };
  if (str(me?.RDB)) box.rdb = str(me?.RDB).toUpperCase();
  try {
    const [u] = (await conn.query("SELECT GROUP_PROFILE_NAME AS G, SUPPLEMENTAL_GROUP_LIST AS S FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = ?", [box.user])).rows;
    if (u) box.groups = [str(u.G), ...supplementalGroups(String(u.S ?? ""))].map((g) => g.toUpperCase()).filter((g) => g && g !== "*NONE");
    else box.notes.push(`QSYS2.USER_INFO has no row for ${box.user}: groups unknown`);
  } catch (e) {
    box.failed = true;
    box.notes.push(`group lookup for ${box.user} failed: ${(e as Error).message}`);
  }
  try {
    const rows = (await conn.query("SELECT AUTHORIZATION_LIST AS A FROM QSYS2.AUTHORIZATION_LIST_USER_INFO WHERE AUTHORIZATION_NAME = ?", [box.user])).rows;
    box.authlists = rows.map((r) => str(r.A).toUpperCase()).filter(Boolean);
  } catch (e) {
    box.failed = true;
    box.notes.push(`authorization list lookup for ${box.user} failed: ${(e as Error).message}`);
  }
  return box;
}

// --- profile guards: the engine's own checks, applied in every mode ---

const EDGE = "[^A-Z0-9#$@_]";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function profileRefusal(s: ClassifiedStatement, profile: Conn["profile"]): string | undefined {
  if (profile.readOnly && (s.kind === "cl" || s.operations.some((o) => o.class !== "read")))
    return "refused: the profile is read-only (IBMI_READ_ONLY), so only SQL reads run";
  const objects = s.operations.flatMap((o) => (o.object ? [o.object.name, o.object.lib && `${o.object.lib}.${o.object.name}`, o.object.schema && `${o.object.schema}.${o.object.name}`] : []));
  const upper = s.display.toUpperCase();
  const table = profile.blockedTables.find(
    (t) => objects.some((n) => n?.toLowerCase() === t) || new RegExp(`(^|${EDGE})${esc(t.toUpperCase())}($|${EDGE})`).test(upper),
  );
  if (table) return `refused: ${table.toUpperCase()} is blocked by IBMI_BLOCKED_TABLES`;
  const command = s.operations.find((o) => o.command && profile.blockedCl.includes(o.command.toLowerCase()))?.command;
  if (command) return `refused: ${command} is blocked by IBMI_BLOCKED_CL`;
  try {
    assertNotRunaway(s.display);
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
  return undefined;
}

// --- the shared decision ---

interface Planned {
  statement: ClassifiedStatement;
  decision: Decision;
  refused?: string;
}

interface Plan {
  server: string;
  policy: Policy;
  runLog: RunLog; // the policy's, kept from the decision so logging never reads the profile again
  generation?: number; // the job the script was decided against
  identity: Identity;
  names?: PartitionNames;
  statements: Planned[];
  lookups: Answers;
  notes: string[];
}

const objectText = (o: NonNullable<ClassifiedStatement["operations"][number]["object"]>) =>
  o.type === "*LIB" ? `library ${o.lib ?? o.name}` : [o.rdb, o.lib, o.name].filter(Boolean).join(".");

// Per statement: the operations with object, partition, environment and class, the rule, the
// decision, and why it does or does not run.
function report(p: { statement: { kind?: string; display: string }; decision: Decision; refused?: string }, i: number) {
  const d = p.decision;
  const r: Record<string, unknown> = {
    index: i + 1,
    kind: p.statement.kind,
    text: p.statement.display,
    decision: d.decision,
    effective: p.refused ? "deny" : d.effective,
    operations: d.operations.map((o) => {
      const op: Record<string, unknown> = { class: o.operation.class, decision: o.decision, enforced: o.enforced, reason: o.reason, message: o.message };
      if (o.operation.object) op.object = objectText(o.operation.object);
      if (o.operation.command) op.command = o.operation.command;
      if (o.partition) op.partition = o.partition;
      if (o.env) op.env = o.env;
      if (o.rule) op.rule = o.rule;
      return op;
    }),
  };
  if (d.reason) r.reason = d.reason;
  if (p.refused) r.refused = p.refused;
  return r;
}

const stopping = (p: Planned) => p.refused !== undefined || p.decision.effective === "deny";
// A statement with no operations (COMMIT) is denied only at statement level, by a partition conflict.
const why = (p: { refused?: string; decision: Decision }, identity: Identity) =>
  p.refused ??
  (p.decision.operations
    .filter((o) => o.enforced && o.decision === "deny")
    .map((o) => o.message)
    .join("; ") ||
    `denied: ${p.decision.reason === "partition_conflict" && identity.conflict ? identity.conflict : (p.decision.reason ?? "no reason given")}`);

// --- engine tools (design D6, D8) ---

type MemberRef = { library: string; sourceFile: string; member: string };
const libRef = (name: string): ObjectRef => ({ lib: name, name, type: "*LIB" });
const toolStatement = (text: string, operations: Operation[]): ToolStatement => ({ kind: "tool", text, display: text, operations });
// For compile_member only: RUNSQLSTM read as a read of its source file, whose member's statements
// are then decided themselves. The command table keeps it danger everywhere else.
const RUNSQLSTM_READ: CommandEntry = { class: "read", positional: ["SRCFILE", "SRCMBR"], params: { SRCFILE: "object" } };
const MEMBER = /^[A-Z#$@][A-Z0-9#$@_.]{0,9}$/;
// compile_member's read of the member whose statements it decides, decided before it is fetched.
const memberRead = (m: MemberRef): Operation => ({ class: "read", object: { lib: m.library, name: m.sourceFile }, source: "sql" });

// What an engine tool call does, as statements (run_sql, compile_member's final command and member
// statements) or as the operations it builds (the rest). Names go through the engine's own
// validation first, so the object decided is the one the engine touches.
export async function toolStatements(
  tool: string,
  input: Record<string, unknown>,
  policy: Policy,
  lookups: Lookups,
  memberText: (ref: MemberRef) => Promise<string | undefined>, // undefined: its read is denied or waits for confirmation, not fetched
): Promise<{ statements: (ClassifiedStatement | ToolStatement)[]; notes: string[] }> {
  const name = (v: unknown, what: string) => validName(String(v ?? ""), what);
  const ctx = { lookups, commands: policy.commands, rdbs: policy.rdbs };
  switch (tool) {
    case "read_source_member":
    case "upload_source_member": {
      const [l, f, m] = [name(input.library, "library"), name(input.sourceFile, "sourceFile"), name(input.member, "member")];
      const op: Operation = { class: tool === "read_source_member" ? "read" : "write", object: { lib: l, name: f }, source: "sql" };
      return { statements: [toolStatement(`${tool} ${l}/${f}(${m})`, [op])], notes: [] };
    }
    case "search_source": {
      const l = name(input.library, "library");
      const f = input.sourceFile ? name(input.sourceFile, "sourceFile") : undefined;
      const op: Operation = { class: "read", object: f ? { lib: l, name: f } : libRef(l), source: "sql" };
      return { statements: [toolStatement(`search_source ${f ? `${l}/${f}` : l}`, [op])], notes: [] };
    }
    case "manage_library_list": {
      // As the engine builds its command: replace drops QTEMP, the others take `library`.
      const names =
        input.action === "replace"
          ? [...((input.libraries as unknown[] | undefined) ?? []).map((l) => name(l, "library")).filter((l) => l !== "QTEMP"), ...(input.currentLibrary ? [name(input.currentLibrary, "currentLibrary")] : [])]
          : [name(input.library, "library")];
      const ops: Operation[] = names.length ? names.map((l) => ({ class: "liblist", object: libRef(l), source: "cl" })) : [{ class: "liblist", source: "cl", command: "CHGLIBL" }];
      return { statements: [toolStatement(`manage_library_list ${input.action} ${names.join(" ")}`.trim(), ops)], notes: [] };
    }
    case "run_sql": {
      const c = await classify(String(input.statement ?? ""), ctx);
      return { statements: c.statements, notes: c.notes };
    }
    case "screen_command": {
      // A 5250 command line runs one command: each is decided, and logged, as a CL line, with
      // the 5250 job's lookups (screenLookups, applied by the caller so the run log keeps them).
      const statements: ClassifiedStatement[] = [];
      const notes: string[] = [];
      for (const command of (input.commands as unknown[] | undefined) ?? []) {
        const text = String(command);
        if (/[\r\n]/.test(text)) throw new Error("refused: a command line holds one line");
        const c = await classify(`CL: ${text}`, ctx);
        statements.push(...c.statements);
        notes.push(...c.notes);
      }
      return { statements, notes };
    }
    case "session_open": {
      // The sign on screen's Program/procedure field calls it, the Current library field sets it.
      // CALL is classified so a program the guard cannot see into (QCMDEXC) is danger, as anywhere.
      const ops: Operation[] = [];
      const notes: string[] = [];
      const parts: string[] = [];
      if (input.program) {
        const [a, b, more] = String(input.program).split("/");
        if (more !== undefined) throw new Error(`invalid program: "${input.program}"`);
        const pgm = b === undefined ? name(a, "program") : `${a.toUpperCase() === "*LIBL" ? "*LIBL" : name(a, "program library")}/${name(b, "program")}`;
        const c = await classify(`CL: CALL PGM(${pgm})`, ctx);
        ops.push(...c.operations);
        notes.push(...c.notes);
        parts.push(`program ${pgm}`);
      }
      if (input.library) {
        const l = name(input.library, "library");
        ops.push({ class: "liblist", object: libRef(l), source: "cl" });
        parts.push(`library ${l}`);
      }
      return { statements: [toolStatement(`session_open ${parts.join(" ")}`, ops)], notes };
    }
    case "compile_member": {
      const command = String(input.command ?? "");
      if (/[\r\n]/.test(command)) throw new Error("refused: the compile command must be one line");
      const notes: string[] = [];
      const statements: (ClassifiedStatement | ToolStatement)[] = [];
      let member: MemberRef | undefined;
      const parsed = parseCl(stripClComments(command).text);
      const runsqlstm = !("error" in parsed) && parsed.name === "RUNSQLSTM";
      if (runsqlstm) {
        const c = await classify(`CL: ${command}`, { ...ctx, commands: { ...policy.commands, RUNSQLSTM: RUNSQLSTM_READ } });
        notes.push(...c.notes);
        const ops = c.operations;
        const src = ops.find((o) => o.command === "RUNSQLSTM" && o.object?.lib && !o.object.lib.startsWith("*"))?.object;
        const params = new Map(parsed.params);
        parsed.positional.forEach((v, i) => params.set(["SRCFILE", "SRCMBR"][i], v));
        const mbr = params.get("SRCMBR")?.trim().toUpperCase();
        if (src && mbr && MEMBER.test(mbr) && !params.has("SRCSTMF")) member = { library: src.lib!, sourceFile: src.name, member: mbr };
        else ops.push({ class: "danger", source: "cl", command: "RUNSQLSTM", reason: "RUNSQLSTM must name SRCFILE(LIB/FILE) and SRCMBR(member), so the statements it runs can be read and decided" });
        statements.push(toolStatement(command, ops));
      } else {
        const c = await classify(`CL: ${command}`, ctx);
        notes.push(...c.notes);
        statements.push(...c.statements);
        if (String(input.type ?? "").toLowerCase() === "sql") member = { library: name(input.library, "library"), sourceFile: name(input.sourceFile, "sourceFile"), member: name(input.member, "member") };
      }
      if (member) {
        const text = await memberText(member);
        if (text !== undefined) {
          const c = await classify(text, ctx);
          notes.push(...c.notes);
          statements.push(...c.statements);
        } else if (!runsqlstm) {
          // Not fetched (its read is denied or waits for confirmation): RUNSQLSTM's own read of SRCFILE says so, else this.
          statements.push(toolStatement(`read ${member.library}/${member.sourceFile}(${member.member})`, [memberRead(member)]));
        }
      }
      return { statements, notes };
    }
    default:
      throw new Error(`refused: ${tool} has no execution guard`);
  }
}

export function registerGuarded(
  mcp: McpServer,
  deps: GuardDeps,
): { verbContext(server: string): Promise<VerbContext>; tool(tool: string, input: Record<string, unknown>, server: string | undefined): Promise<(outcome: string) => void> } {
  const boxes = new Map<string, Promise<Box>>();

  async function identityOf(server: string, conn: Conn, policy: Policy): Promise<{ identity: Identity; names: PartitionNames; notes: string[] }> {
    let p = boxes.get(server);
    if (!p) {
      const read = (p = readBox(conn));
      boxes.set(server, read);
      const drop = () => boxes.get(server) === read && boxes.delete(server);
      void read.then((b) => b.failed && drop(), drop); // only a successful lookup is kept: a failed one is asked again next call
    }
    const box = await p;
    const names: PartitionNames = {};
    const system = deps.systemName(server);
    if (system) names.system = system.toUpperCase();
    if (box.rdb) names.rdb = box.rdb;
    const declared = deps.profileEnv(server).IBMI_PARTITION?.trim();
    if (declared) names.declared = declared;
    const found = detectPartition(policy, names);
    const identity: Identity = { user: box.user };
    if (box.groups) identity.groups = box.groups;
    if (box.authlists) identity.authlists = box.authlists;
    if (found.partition !== undefined) identity.partition = found.partition;
    if (found.conflict !== undefined) identity.conflict = found.conflict;
    return { identity, names, notes: box.notes };
  }

  // Every statement of the script decided, and the profile's own guards applied, before anything
  // is sent. Only the identity and catalog lookups reach the box.
  async function plan(server: string, script: string): Promise<{ plan: Plan; conn: Conn }> {
    const { policy, runLog } = deps.policyFor(server);
    const conn = deps.conn(server);
    const generation = conn.generation; // before any lookup: every answer must come from this job
    const who = await identityOf(server, conn, policy);
    const { lookups, answers } = recordLookups(sqlLookups(conn));
    const { classification, decisions } = await decideStatements(script, who.identity, policy, lookups);
    const statements = classification.statements.map((statement, i): Planned => {
      const p: Planned = { statement, decision: decisions[i] };
      const refused = profileRefusal(statement, conn.profile);
      if (refused) p.refused = refused;
      return p;
    });
    return { conn, plan: { server, policy, runLog, generation, identity: who.identity, names: who.names, statements, lookups: answers, notes: [...who.notes, ...classification.notes] } };
  }

  function log(p: Plan, conn: Conn, outcomes: string[], confirmed?: boolean): void {
    p.runLog.record({
      server: p.server,
      tool: "run_script",
      identity: p.identity,
      ...(p.names ? { names: p.names } : {}),
      lookups: p.lookups,
      notes: p.notes,
      secret: conn.profile.password,
      statements: p.statements.map((s, i) => ({
        statement: s.statement,
        decision: s.decision,
        outcome: outcomes[i],
        ...(confirmed !== undefined && s.decision.effective === "confirm" ? { confirmed } : {}),
      })),
    });
  }

  // One elicitation for every statement a rule asks to confirm (design D7). Anything but accept
  // with confirm: true is a no. Returns why not, or undefined for a yes.
  async function confirm(server: string, identity: Identity, needs: ConfirmItem[]): Promise<string | undefined> {
    if (!mcp.server.getClientCapabilities()?.elicitation?.form)
      return "confirmation is unavailable in this client (it does not support MCP elicitation), so the statements a rule asks to confirm are denied";
    const lines = [`Run on server ${server}${identity.partition ? ` (partition ${identity.partition})` : ""}? Nothing runs unless you confirm.`];
    for (const s of needs) {
      lines.push("", `${s.label}:`);
      for (const o of s.decision.operations) lines.push(`  - ${o.operation.class} ${o.operation.object ? objectText(o.operation.object) : (o.operation.command ?? "")}${o.env ? ` (environment ${o.env})` : ""}`);
      lines.push(s.display);
    }
    try {
      const r = await mcp.server.elicitInput(
        {
          mode: "form",
          message: lines.join("\n"),
          requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Run these statements" } }, required: ["confirm"] },
        },
        { timeout: deps.confirmTimeoutMs },
      );
      if (r.action === "accept" && r.content?.confirm === true) return undefined;
      return r.action === "accept" ? "the user did not confirm" : `the user chose ${r.action}`;
    } catch (e) {
      return `no confirmation: ${(e as Error).message}`;
    }
  }

  // Queries only, as run_sql: past the limit the session is reset, which the next send's
  // generation check sees. DML and CL run to the end: cutting one off leaves it half-done.
  const limitedOn = (conn: Conn) => <T>(work: Promise<T>) =>
    withTimeLimit(work, deps.sqlTimeLimitMs, () => void conn.close().catch(() => {}), `gave up after ${deps.sqlTimeLimitMs / 1000}s and reset the session, so the query may still be running on the box`);

  // What verbs (project-verbs) decide and run with: the same identity, lookups, profile guards,
  // confirmation and run log as run_script, and sends checked against the job the verbs were
  // decided on: after a reset nothing more is sent.
  async function verbContext(server: string): Promise<VerbContext> {
    const { policy, runLog } = deps.policyFor(server);
    const conn = deps.conn(server);
    const generation = conn.generation; // before any lookup: every answer must come from this job
    const who = await identityOf(server, conn, policy);
    const limited = limitedOn(conn);
    return {
      policy,
      identity: who.identity,
      lookups: sqlLookups(conn),
      refusal: (s) => profileRefusal(s, conn.profile),
      confirm: (needs) => confirm(server, who.identity, needs),
      recheck: (answers) => curlibMoved(conn, answers),
      exec: {
        query: (sql, params, maxRows) => limited(conn.query(sql, params, maxRows, undefined, generation)),
        execute: (sql, params) => conn.execute(sql, params, undefined, generation),
        cl: (command) => conn.cl(command, undefined, generation),
        stale: () => conn.generation !== generation,
      },
      log: (call) =>
        runLog.record({ ...call, server, identity: who.identity, ...(Object.keys(who.names).length ? { names: who.names } : {}), notes: [...who.notes, ...(call.notes ?? [])], secret: conn.profile.password }),
    };
  }

  const key = (server?: string) => server || "default";

  // The engines' hook (design D6): an engine tool call decided and confirmed before the
  // engine acts. Throws to refuse (logged then); otherwise returns what logs the call's outcome.
  async function guardTool(tool: string, input: Record<string, unknown>, server: string | undefined): Promise<(outcome: string) => void> {
    const s = key(server);
    const { policy, runLog } = deps.policyFor(s);
    const conn = deps.conn(s);
    const who = await identityOf(s, conn, policy);
    const screen = tool === "screen_command";
    const { lookups, answers } = recordLookups(screen ? screenLookups(sqlLookups(conn)) : sqlLookups(conn));
    const fetch = async (ref: MemberRef) => {
      try {
        return await deps.memberText(s, ref);
      } catch (e) {
        throw new Error(`refused: cannot read ${ref.library}/${ref.sourceFile}(${ref.member}) to decide its statements: ${(e as Error).message}`);
      }
    };
    // A member whose read the policy denies is never fetched; one whose read a rule asks to confirm
    // is fetched only after a yes. Its text reaches no message before then.
    let deferred: MemberRef | undefined;
    const memberText = async (ref: MemberRef) => {
      const read = decide([memberRead(ref)], who.identity, policy).effective;
      if (read === "deny") return undefined;
      if (read === "confirm") {
        deferred = ref;
        return undefined;
      }
      return fetch(ref);
    };
    const { statements, notes } = await toolStatements(tool, input, policy, lookups, memberText);
    type Step = { statement: (typeof statements)[number]; decision: Decision; confirmed?: boolean };
    const planOf = (list: typeof statements): Step[] => list.map((statement) => ({ statement, decision: decide(statement.operations, who.identity, policy) }));
    const planned = planOf(statements);
    const record = (outcome: (p: Step) => string) =>
      runLog.record({
        server: s,
        tool,
        identity: who.identity,
        ...(Object.keys(who.names).length ? { names: who.names } : {}),
        lookups: answers,
        notes: [...who.notes, ...notes],
        secret: conn.profile.password,
        statements: planned.map((p) => ({ ...p, outcome: outcome(p) })),
      });

    // Deny refuses, confirm asks, for these steps; every step is logged on a refusal.
    let asked = false;
    const gate = async (steps: Step[]) => {
      const denied = steps.filter((p) => p.decision.effective === "deny");
      if (denied.length) {
        record((p) => (p.decision.effective === "deny" ? `denied: ${why(p, who.identity)}` : "not sent: another operation was denied"));
        throw new Error([`Denied, ${tool} did nothing:`, ...denied.map((p) => `  ${p.statement.display.split("\n")[0]}: ${why(p, who.identity)}`), ASK, LIMITS].join("\n"));
      }
      const needs = steps.filter((p) => p.decision.effective === "confirm");
      if (!needs.length) return;
      asked = true;
      const no = await confirm(s, who.identity, needs.map((p, i) => ({ label: `${tool}${needs.length > 1 ? ` ${i + 1}` : ""}`, decision: p.decision, display: p.statement.display })));
      for (const p of needs) p.confirmed = no === undefined;
      if (no) {
        record(() => `not sent: ${no}`);
        throw new Error(`Denied, ${tool} did nothing: ${no}.\n${ASK}\n${LIMITS}`);
      }
    };
    // A deferred member read is in this first prompt (its read line, or RUNSQLSTM's read of SRCFILE).
    await gate(planned);
    if (deferred) {
      let text: string;
      try {
        text = await fetch(deferred);
      } catch (e) {
        record(() => `not sent: ${(e as Error).message}`);
        throw e;
      }
      // *CURLIB as recorded before the wait: asking again would overwrite it, and the recheck below would compare the new value with itself.
      const known: Lookups = "curlib" in answers ? { ...lookups, currentLibrary: async () => answers.curlib ?? undefined } : lookups;
      const c = await classify(text, { lookups: known, commands: policy.commands, rdbs: policy.rdbs });
      notes.push(...c.notes);
      const more = planOf(c.statements);
      planned.push(...more);
      await gate(more);
    }
    // The SQL job's current library says nothing about the 5250 job's.
    const moved = asked && !screen ? await curlibMoved(conn, answers) : undefined;
    if (moved) {
      record(() => `not sent: ${moved}`);
      throw new Error(`Denied, ${tool} did nothing: ${moved}.\n${ASK}\n${LIMITS}`);
    }
    // Allowed: logged once the engine says how the call ended.
    return (outcome) => record(() => outcome);
  }

  const serverArg = z.string().optional().describe("which IBM i to use, named by a .env.<name> file. Omit for the default .env server (see list_servers)");
  const result = (structured: Record<string, unknown>, text: string, isError = false) => ({
    content: [{ type: "text" as const, text }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  });
  const fail = (e: unknown) => result({ error: (e as Error).message ?? String(e) }, `failed: ${(e as Error).message ?? String(e)}`, true);

  mcp.registerTool(
    "run_script",
    {
      title: "Run script",
      description:
        "Run SQL statements (separated by ;) and CL commands (lines starting CL:) on IBM i, in order. Every statement is classified and decided by the execution policy, and every confirmation asked, before the first is sent: one denied statement or a declined confirmation sends nothing. Stops at the first failure. Returns per statement its decision, outcome, rows affected, rows (up to maxRows) and messages. Use policy_check first to see what the policy would decide. " +
        LIMITS,
      inputSchema: {
        script: z.string().min(1).describe("SQL statements separated by ; and CL commands on lines starting CL: (+ continues a CL line)"),
        maxRows: z.number().int().min(1).max(1000).optional().describe("rows returned per query, default 100, at most 1000"),
        server: serverArg,
      },
      annotations: { title: "Run script", destructiveHint: true },
    },
    async ({ script, maxRows, server }) => {
      const s = key(server);
      let planned: { plan: Plan; conn: Conn };
      try {
        planned = await plan(s, script);
      } catch (e) {
        return fail(e);
      }
      const { plan: p, conn } = planned;
      const { generation } = p;
      const summary = { server: s, partition: p.identity.partition, roles: p.statements[0]?.decision.roles ?? [] };

      const stopped = p.statements.filter(stopping);
      if (stopped.length) {
        log(p, conn, p.statements.map((x) => (stopping(x) ? `denied: ${why(x, p.identity)}` : "not sent: another statement was denied")));
        const text = [
          "Denied, nothing was sent:",
          ...stopped.map((x) => `  statement ${p.statements.indexOf(x) + 1} (${x.statement.display.split("\n")[0]}): ${why(x, p.identity)}`),
          ASK,
          LIMITS,
        ].join("\n");
        return result({ ...summary, ran: false, statements: p.statements.map((x, i) => ({ ...report(x, i), outcome: stopping(x) ? "denied" : "not sent" })), limits: LIMITS }, text, true);
      }

      const needs = p.statements.filter((x) => x.decision.effective === "confirm");
      if (needs.length) {
        const no = await confirm(p.server, p.identity, needs.map((s) => ({ label: `Statement ${p.statements.indexOf(s) + 1}`, decision: s.decision, display: s.statement.display })));
        if (no) {
          log(p, conn, p.statements.map(() => `not sent: ${no}`), false);
          const text = `Denied, nothing was sent: ${no}.\n${ASK}\n${LIMITS}`;
          return result({ ...summary, ran: false, statements: p.statements.map((x, i) => ({ ...report(x, i), outcome: "not sent" })), limits: LIMITS }, text, true);
        }
        const moved = await curlibMoved(conn, p.lookups);
        if (moved) {
          log(p, conn, p.statements.map(() => `not sent: ${moved}`), true);
          return result({ ...summary, ran: false, statements: p.statements.map((x, i) => ({ ...report(x, i), outcome: "not sent" })), limits: LIMITS }, `Denied, nothing was sent: ${moved}.\n${ASK}`, true);
        }
      }

      const cap = maxRows ?? 100;
      const outcomes: string[] = [];
      const done: Record<string, unknown>[] = [];
      let stop: string | undefined;
      const limited = limitedOn(conn);
      for (const [i, x] of p.statements.entries()) {
        const r = report(x, i);
        if (stop) {
          outcomes.push(`not sent: ${stop}`);
          done.push({ ...r, outcome: "not sent" });
          continue;
        }
        try {
          if (x.statement.kind === "cl") {
            // The comment-stripped command: blanks outside quotes collapse, quoted values are kept.
            const c = await conn.cl(x.statement.display, undefined, generation);
            r.messages = c.messages;
            if (!c.ok) throw new Error(c.messages.map((m) => (m.id ? `[${m.id}] ${m.text}` : m.text)).join(" ") || "the command failed");
            outcomes.push("ok");
          } else if (QUERY.test(x.statement.display)) {
            // As written: the display drops blank lines, which may sit inside a literal.
            const q = await limited(conn.query(x.statement.text, undefined, cap, undefined, generation));
            Object.assign(r, { columns: q.columns.map((c) => c.name), rows: q.rows, truncated: q.truncated });
            outcomes.push(`${q.rows.length} row(s)${q.truncated ? `, truncated at ${cap}` : ""}`);
          } else {
            const e = await conn.execute(x.statement.text, undefined, undefined, generation);
            Object.assign(r, { rowsAffected: e.rowsAffected, messages: e.messages });
            outcomes.push(`${e.rowsAffected} row(s) affected`);
          }
          done.push({ ...r, outcome: "ok" });
        } catch (e) {
          stop = "an earlier statement failed";
          outcomes.push(`failed: ${(e as Error).message}`);
          done.push({ ...r, outcome: "failed", error: (e as Error).message });
        }
      }
      log(p, conn, outcomes, needs.length ? true : undefined);
      const text = done.map((_, i) => `statement ${i + 1}: ${outcomes[i]}`).join("\n") + (stop ? `\nStopped: ${stop}; later statements were not sent.` : "");
      return result({ ...summary, ran: true, statements: done }, `${text}\n\n${JSON.stringify(done, null, 2)}`, stop !== undefined);
    },
  );

  const asSchema = z
    .object({
      user: z.string().min(1),
      groups: z.array(z.string()).optional(),
      authlists: z.array(z.string()).optional(),
      partition: z.string().optional(),
      curlib: z.string().optional(),
    })
    .strict();

  mcp.registerTool(
    "policy_check",
    {
      title: "Policy check",
      description:
        "Decide a script (SQL statements separated by ;, CL commands on lines starting CL:), or every statement a verb would send (nested verbs and cleanup included), without running it: per statement the operations with library, partition, environment and class, the matching rule and the decision. Sends only the catalog lookups needed to decide. With `as` (and optionally `policy`, a candidate policy file) it decides offline for that identity and sends nothing. " +
        LIMITS,
      inputSchema: {
        script: z.string().min(1).optional().describe("SQL statements separated by ; and CL commands on lines starting CL:; give this or verb"),
        verb: verbCheckInput.verb.optional(),
        args: verbCheckInput.args,
        server: serverArg,
        policy: z.string().optional().describe("a candidate policy file to decide with instead of the loaded one; needs `as`"),
        as: asSchema.optional().describe("decide offline for this identity instead of the signed-on user; nothing is sent"),
      },
      annotations: { title: "Policy check", readOnlyHint: true },
    },
    async ({ script, verb, args, server, policy: candidate, as }) => {
      try {
        if ((script === undefined) === (verb === undefined)) throw new Error("give exactly one of script and verb");
        if (args && verb === undefined) throw new Error("args go with verb");
        let statements: Record<string, unknown>[];
        let head: Record<string, unknown>;
        if (as) {
          const used = candidate ? loadPolicy(candidate) : deps.policyFor(key(server)).policy;
          const input = verb !== undefined ? { verb, ...(args ? { args } : {}) } : { script };
          const [t] = await runPolicyTests(used, [{ name: "policy_check", as, ...input, expect: "allow" }], verb !== undefined ? deps.verbs(key(server)) : undefined);
          head = { policy: used.source, as, offline: true };
          statements = t.statements.map((x, i) => report({ statement: { display: x.text }, decision: x.decision, ...(x.refused ? { refused: x.refused } : {}) }, i));
        } else {
          if (candidate) throw new Error("a candidate `policy` is decided offline: state the identity in `as` too");
          let identity: Identity;
          let roles: string[];
          if (verb !== undefined) {
            const ctx = await verbContext(key(server));
            const r = await checkVerb(ctx, deps.verbs(key(server)), verb, args);
            identity = ctx.identity;
            roles = r.statements[0]?.decision.roles ?? [];
            // A verb's read-only rule for requires_absent and expect refuses like a profile guard: deny.
            statements = r.statements.map((x, i) => ({ ...report({ statement: x.statement, decision: x.decision, ...(x.refused ? { refused: x.refused } : {}) }, i), verb: x.planned.verb, where: x.planned.where }));
            head = { verb: r.verb, file: r.file };
          } else {
            const { plan: p } = await plan(key(server), script as string);
            identity = p.identity;
            roles = p.statements[0]?.decision.roles ?? [];
            statements = p.statements.map(report);
            head = {};
          }
          head = { server: key(server), partition: identity.partition, roles, user: identity.user, ...head };
          if (identity.conflict) head.conflict = identity.conflict;
        }
        const lines = statements.map((r) => {
          const ops = (r.operations as { message: string }[]).map((o) => `    - ${o.message}`);
          return [`statement ${r.index}${r.where ? ` (${r.verb} ${r.where})` : ""}: ${r.effective}${r.effective !== r.decision && !r.refused ? ` (policy: ${r.decision}, not enforced)` : ""}${r.refused ? ` (${r.refused})` : ""}`, `    ${String(r.text).split("\n")[0]}`, ...ops].join("\n");
        });
        return result({ ...head, statements, limits: LIMITS }, `${lines.join("\n")}\n\n${LIMITS}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // Design D7: whether confirmation is possible is worth one line on stderr per client.
  const before = mcp.server.oninitialized;
  mcp.server.oninitialized = () => {
    before?.();
    deps.notice(
      mcp.server.getClientCapabilities()?.elicitation?.form
        ? "[ibmi-agent-kit] confirmation is available in this client"
        : "[ibmi-agent-kit] confirmation is unavailable in this client: statements a rule asks to confirm are denied",
    );
  };

  return { verbContext, tool: guardTool };
}
