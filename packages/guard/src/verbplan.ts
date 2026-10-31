// A verb run planned and decided before anything is sent (project-verbs design D2): every list of
// the verb and of each nested verb bound and substituted, then classified as one script in run
// order and decided. The server's runner, policy_check and policy test share it.
import { classify } from "./classify.js";
import { decide, type Decision, type Identity } from "./decide.js";
import type { Policy } from "./policy.js";
import type { ClassifiedStatement, Lookups, Operation } from "./types.js";
import { bindArgs, callArgs, MAX_VERB_DEPTH, resolveVerb, substitute, type Value, type Values, type Verb, type VerbSet, type VerbStep } from "./verbs.js";

export type PlannedRole = "requires_absent" | "setup" | "step" | "expect" | "cleanup";

export interface Planned {
  verb: string; // the address of the verb it belongs to
  where: string; // setup.0, setup.0.requires_absent, steps.1, steps.2.expect, cleanup.0
  role: PlannedRole;
  kind: "sql" | "cl";
  text: string;
  params: Value[]; // one per ? marker
  check?: Omit<NonNullable<VerbStep["expect"]>, "sql">; // an expect step's equals, rows or empty
  undoes?: string; // a cleanup entry's setup id
}

export interface PlannedVerb {
  verb: Verb;
  values: Values;
  setup: { id?: string; requiresAbsent?: Planned; run: Planned }[];
  steps: (Planned | PlannedVerb)[];
  cleanup: Planned[];
}

export const isPlannedVerb = (s: Planned | PlannedVerb): s is PlannedVerb => "values" in s;

// Bind and substitute a verb and every verb it calls. Throws, naming the verb and step, before
// anything could be sent.
export function planVerb(set: VerbSet, ref: string, args?: Record<string, unknown>, chain: string[] = []): PlannedVerb {
  const verb = resolveVerb(set, ref);
  const path = [...chain, verb.address];
  // loading refuses deeper chains; this holds even for a set that was not loaded
  if (path.length > MAX_VERB_DEPTH) throw new Error(`more than ${MAX_VERB_DEPTH} verbs in one call chain: ${path.join(" → ")}`);
  const values = bindArgs(verb, args);
  const at = (where: string, role: PlannedRole, s: { sql?: string; cl?: string }): Planned => {
    const kind = s.sql !== undefined ? "sql" : "cl";
    try {
      const { text, params } = substitute((s.sql ?? s.cl) as string, kind, verb.params, values);
      return { verb: verb.address, where, role, kind, text, params };
    } catch (e) {
      throw new Error(`${verb.address} ${where}: ${(e as Error).message}`);
    }
  };
  return {
    verb,
    values,
    setup: verb.setup.map((s, i) => {
      const p: PlannedVerb["setup"][number] = { run: at(`setup.${i}`, "setup", s) };
      if (s.id !== undefined) p.id = s.id;
      if (s.requires_absent !== undefined) p.requiresAbsent = at(`setup.${i}.requires_absent`, "requires_absent", { sql: s.requires_absent });
      return p;
    }),
    steps: verb.steps.map((s, i): Planned | PlannedVerb => {
      if (s.verb !== undefined) {
        let a: Record<string, unknown>;
        try {
          a = callArgs(s, verb.params, values);
        } catch (e) {
          throw new Error(`${verb.address} steps.${i}: ${(e as Error).message}`);
        }
        return planVerb(set, s.verb, a, path);
      }
      if (s.expect) {
        const { sql, ...check } = s.expect;
        return { ...at(`steps.${i}.expect`, "expect", { sql }), check };
      }
      return at(`steps.${i}`, "step", s);
    }),
    cleanup: verb.cleanup.map((s, i) => ({ ...at(`cleanup.${i}`, "cleanup", s), undoes: s.undoes })),
  };
}

// Every statement in run order: each setup's requires_absent then its statement, the steps with
// nested verbs in place, then the cleanup entries (decided even if they will not run).
export function plannedStatements(p: PlannedVerb): Planned[] {
  return [
    ...p.setup.flatMap((s) => (s.requiresAbsent ? [s.requiresAbsent, s.run] : [s.run])),
    ...p.steps.flatMap((s) => (isPlannedVerb(s) ? plannedStatements(s) : [s])),
    ...p.cleanup,
  ];
}

export interface DecidedStatement {
  planned: Planned;
  statement: ClassifiedStatement;
  decision: Decision;
}

const what = (o: Operation) => `${o.class}${o.object ? ` ${[o.object.rdb, o.object.lib, o.object.name].filter(Boolean).join(".")}` : ""}`;

// Classify the whole plan as one script, so what an earlier statement set up (a QTEMP alias) is
// seen by later ones, and decide each statement. `refusals` holds requires_absent and expect
// queries the classifier finds doing more than reading: they are refused in every mode.
export async function decideVerb(plan: PlannedVerb, identity: Identity, policy: Policy, lookups: Lookups): Promise<{ statements: DecidedStatement[]; notes: string[]; refusals: string[] }> {
  const list = plannedStatements(plan);
  const script = list.map((s) => (s.kind === "cl" ? `CL: ${s.text}\n` : `${s.text}\n;\n`)).join("");
  const c = await classify(script, { lookups, commands: policy.commands, rdbs: policy.rdbs });
  if (c.statements.length !== list.length || c.statements.some((s, i) => s.kind !== list[i].kind))
    throw new Error(`${plan.verb.address}: its ${list.length} statements read back as ${c.statements.length} in one script, so they cannot be decided`);
  const refusals: string[] = [];
  const statements = list.map((planned, i) => {
    const statement = c.statements[i];
    const more = statement.operations.filter((o) => o.class !== "read");
    if ((planned.role === "requires_absent" || planned.role === "expect") && more.length)
      refusals.push(`${planned.verb} ${planned.where}: a ${planned.role} query must only read, but it is ${more.map(what).join(", ")}`);
    return { planned, statement, decision: decide(statement.operations, identity, policy) };
  });
  return { statements, notes: c.notes, refusals };
}
