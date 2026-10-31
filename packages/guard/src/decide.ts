// Who, where and which environment (design D4, D5): the matching `decide` builds on. The server
// supplies the names it read from the box; policy tests state them.
import type { Policy } from "./policy.js";

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
