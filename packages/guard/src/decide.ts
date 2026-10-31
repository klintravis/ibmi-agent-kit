// decide() (design D4) and the matching it builds on: who, where and which environment. The server
// supplies the names it read from the box; policy tests state them.
import type { Mode, Policy, Verdict } from "./policy.js";
import type { Operation } from "./types.js";

export interface Identity {
  user: string;
  // Group profile and supplemental groups, and the authorization lists naming the user; absent
  // when the lookup failed or returned no row.
  groups?: string[];
  authlists?: string[];
  partition?: string; // from detectPartition
  conflict?: string; // from detectPartition: the partitions the names disagree on
}

const SYSTEM_NAME = /^[A-Z#$@][A-Z0-9#$@_]{0,9}$/;

function glob(pattern: string, user: string): RegExp {
  const text = pattern.replaceAll("${USER}", user).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${text}$`);
}

// The environment of a library on a partition: the first entry that applies to the partition and
// names the library, exact names before patterns; `unmatched` when none does. Only a system name
// can match, so a long schema name the lookup could not resolve is `unmatched`.
export function environmentOf(library: string, partition: string | undefined, user: string, policy: Policy): string {
  const lib = library.toUpperCase();
  const me = user.toUpperCase();
  if (!SYSTEM_NAME.test(lib)) return "unmatched";
  for (const e of policy.environments) {
    if (e.partitions && (!partition || !e.partitions.includes(partition))) continue;
    if (e.libraries.includes(lib) || e.match.some((m) => glob(m, me).test(lib))) return e.name;
  }
  return "unmatched";
}

// The partition from the 5250 System name, the SQL RDB name and the profile's IBMI_PARTITION.
// Every name that maps must map to the same partition, and a declared partition must exist; with
// nothing mapped, `unknown_partition`.
export function detectPartition(policy: Policy, names: { system?: string; rdb?: string; declared?: string }): { partition?: string; conflict?: string } {
  const found: string[] = [];
  const system = names.system?.toUpperCase();
  const rdb = names.rdb?.toUpperCase();
  for (const p of policy.partitions) {
    if ((system && p.systems.includes(system)) || (rdb && p.rdbs.includes(rdb))) found.push(p.name);
  }
  if (names.declared !== undefined) {
    if (!policy.partitions.some((p) => p.name === names.declared)) return { conflict: `IBMI_PARTITION ${names.declared} is not a partition of the policy` };
    found.push(names.declared);
  }
  const distinct = [...new Set(found)];
  if (distinct.length > 1) {
    const said = [system && `System ${system}`, rdb && `RDB ${rdb}`, names.declared && `IBMI_PARTITION ${names.declared}`].filter(Boolean).join(", ");
    return { conflict: `${said} map to different partitions: ${distinct.join(" and ")}` };
  }
  const partition = distinct[0] ?? policy.unknownPartition;
  return partition ? { partition } : {};
}

// Every role whose sources match, else `default_role`. A failed group lookup only drops the group
// and authorization-list sources: user names still match, so a contractor whose lookup fails is
// still a contractor and does not fall back to the default role.
export function rolesOf(identity: Identity, policy: Policy): string[] {
  const user = identity.user.toUpperCase();
  const groups = (identity.groups ?? []).map((g) => g.toUpperCase());
  const authlists = (identity.authlists ?? []).map((a) => a.toUpperCase());
  const held = policy.roles
    .filter((r) => r.groups.some((g) => groups.includes(g)) || r.authlists.some((a) => authlists.includes(a)) || r.users.some((u) => glob(u, user).test(user)))
    .map((r) => r.name);
  if (held.length) return held;
  return policy.defaultRole ? [policy.defaultRole] : [];
}

export interface OperationDecision {
  operation: Operation;
  partition?: string; // the operation's own (a mapped RDB, a parameter's partition:) or the connection's
  env?: string; // absent for an operation on no object (WRKACTJOB, CMPRM ... LEVEL(QA)) and for danger
  decision: Verdict;
  // Whether the decision is applied: false when observe mode logs a deny or confirm and runs it.
  enforced: boolean;
  // rule: rule `rule` matched; no_rule: none did (deny); danger, unqualified, partition_conflict:
  // denied before any rule, in every mode; unknown_command: a danger observe mode lets run.
  reason: "rule" | "no_rule" | "danger" | "unqualified" | "unknown_command" | "partition_conflict";
  rule?: number; // 1-based
  message: string;
}

export interface Decision {
  decision: Verdict; // the most restrictive decision of the operations
  effective: Verdict; // what happens: the most restrictive enforced decision, else allow
  enforced: boolean; // effective is not allow
  operations: OperationDecision[];
  // Only for a statement with no operations (COMMIT, VALUES 1): allowed as nothing to decide, or
  // denied with every other statement when the partition names disagree.
  reason?: "no_operations" | "partition_conflict";
}

const RANK: Record<Verdict, number> = { allow: 0, confirm: 1, deny: 2 };
const VERB: Record<Verdict, string> = { allow: "allows", confirm: "asks to confirm", deny: "denies" };
const worst = (vs: Verdict[]): Verdict => vs.reduce<Verdict>((a, b) => (RANK[b] > RANK[a] ? b : a), "allow");

function describe(op: Operation): string {
  const o = op.object;
  const what = !o ? "" : o.type === "*LIB" ? ` library ${o.lib ?? o.name}` : ` ${[o.rdb, o.lib, o.name].filter(Boolean).join(".")}`;
  return `${op.command && !o ? `${op.command} ` : ""}${op.class}${what}`;
}

const hit = (key: string[] | undefined, value: string | undefined) => !key || (value !== undefined && key.includes(value));

// Decide one statement's operations for an identity. A statement takes its most restrictive
// operation; in observe mode only danger, unqualified and a partition conflict are enforced.
export function decide(operations: Operation[], identity: Identity, policy: Policy): Decision {
  if (!operations.length) {
    if (identity.conflict) return { decision: "deny", effective: "deny", enforced: true, operations: [], reason: "partition_conflict" };
    return { decision: "allow", effective: "allow", enforced: false, operations: [], reason: "no_operations" };
  }
  const roles = rolesOf(identity, policy);
  const modeOf = (partition: string | undefined): Mode => (partition && policy.mode.partitions[partition]) || policy.mode.default;
  const decided = operations.map((op): OperationDecision => {
    // An identity built without a partition is an unknown box, never "no partition".
    const partition = op.partition ?? identity.partition ?? policy.unknownPartition;
    const d = (decision: Verdict, reason: OperationDecision["reason"], message: string, hard: boolean): OperationDecision => {
      const r: OperationDecision = { operation: op, decision, enforced: decision !== "allow" && (hard || modeOf(partition) === "enforce"), reason, message };
      if (partition) r.partition = partition;
      return r;
    };
    if (identity.conflict) return d("deny", "partition_conflict", `denied: ${identity.conflict}`, true);
    if (op.class === "danger") {
      if (op.code === "unknown_command") return d("deny", "unknown_command", op.reason ?? "not in the command table", false);
      return d("deny", "danger", op.reason ?? `${describe(op)} is danger`, true);
    }
    if (op.class === "unqualified") return d("deny", "unqualified", op.reason ?? `${describe(op)} is unqualified: name the library`, true);

    const lib = op.object?.type === "*LIB" ? (op.object.lib ?? op.object.name) : op.object?.lib;
    const env = op.env ?? (op.object ? (lib ? environmentOf(lib, partition, identity.user, policy) : "unqualified") : undefined);
    const where = [env && `environment ${env}`, partition && `partition ${partition}`].filter(Boolean).join(", ");
    const i = policy.rules.findIndex(
      (r) => (!r.roles || roles.some((x) => r.roles!.includes(x))) && hit(r.partition, partition) && hit(r.env, env) && hit(r.classes, String(op.class)),
    );
    const r =
      i < 0
        ? d("deny", "no_rule", `no rule matches ${describe(op)}${where ? ` (${where})` : ""}: denied`, false)
        : d(policy.rules[i].decision, "rule", `rule ${i + 1} ${VERB[policy.rules[i].decision]} ${describe(op)}${where ? ` (${where})` : ""}`, false);
    if (i >= 0) r.rule = i + 1;
    if (env) r.env = env;
    return r;
  });
  const decision = worst(decided.map((o) => o.decision));
  const effective = worst(decided.filter((o) => o.enforced).map((o) => o.decision));
  return { decision, effective, enforced: effective !== "allow", operations: decided };
}
