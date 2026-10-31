// What the SQL and CL recognisers share while one script is classified: the context, how deep the
// QCMDEXC / RUNSQL nesting is, the connection a CONNECT switched to, and the aliases and views the
// script itself created (the box cannot know them yet: every statement is decided before the first
// is sent).
import type { CommandTable } from "./commands.js";
import type { ObjectRef, OpClass, Operation } from "./types.js";

export interface ScriptState {
  rdb?: string; // after CONNECT TO / SET CONNECTION to a mapped database
  partition?: string;
  local: Map<string, ObjectRef[]>; // "LIB.NAME" of an alias or view created earlier → its bases
}

export interface Run {
  commands: CommandTable;
  rdbs: Record<string, string>;
  via: string[];
  state: ScriptState;
  nestedSql(text: string, via: string): Operation[];
  nestedCl(text: string, via: string): Operation[];
}

export const MAX_DEPTH = 4;

export function danger(source: "sql" | "cl", reason: string, run: Run, extra: Partial<Operation> = {}): Operation {
  const op: Operation = { class: "danger", source, reason, ...extra };
  if (run.via.length) op.via = [...run.via];
  return op;
}

// The one place an object becomes an operation: an unqualified change is `unqualified`, which no
// rule can allow; an unqualified read or call is decided in environment `unqualified`; an RDB no
// partition lists is `danger`.
export function objectOp(cls: OpClass, object: ObjectRef, source: "sql" | "cl", run: Run, extra: Partial<Operation> = {}): Operation {
  const op: Operation = { class: cls, object, source, ...extra };
  if (run.via.length) op.via = [...run.via];
  if (!object.rdb && run.state.rdb) object.rdb = run.state.rdb;
  if (object.rdb) {
    const partition = run.rdbs[object.rdb];
    if (!partition) {
      return { ...op, class: "danger", reason: `${object.rdb} is another database and no partition lists it in rdbs` };
    }
    op.partition = partition;
  }
  if (!object.lib && cls !== "danger") {
    if (cls === "read" || cls === "call") op.env = "unqualified";
    else {
      op.class = "unqualified";
      op.reason = `name the library: ${object.name} is unqualified, so the ${source === "cl" ? "library list" : "default schema or library list"} decides which library this ${cls} reaches`;
    }
  }
  return op;
}
