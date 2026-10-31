// Shared shapes for the classifier. The guard is pure: everything it needs from the box comes in
// through `Lookups`, which the server implements over the transport and policy tests stub.

// The classes the kit itself knows. A command table may add more through `class_by_param`.
export const BUILTIN_CLASSES = ["read", "write", "ddl", "compile", "call", "liblist", "promote", "danger"] as const;
export type BuiltinClass = (typeof BUILTIN_CLASSES)[number];

// `unqualified` is a class the classifier gives and no rule can allow; it is not in the table's
// vocabulary because no command entry may declare it.
export type OpClass = BuiltinClass | "unqualified" | (string & {});

export interface ObjectRef {
  rdb?: string; // set for a three-part name or a CL RDB() parameter
  lib?: string; // system name once resolved; absent means unqualified
  name: string;
  type?: "*LIB"; // the library itself (CREATE SCHEMA, DLTLIB LIB(X), ADDLIBLE)
  schema?: string; // the long SQL schema name `lib` was resolved from
}

export interface Operation {
  class: OpClass;
  object?: ObjectRef; // absent for a command with no object parameter, a danger, a session change
  env?: "unqualified"; // an unqualified read or call: decided in environment `unqualified`
  partition?: string; // from a mapped RDB or a parameter's `partition:`
  source: "sql" | "cl";
  command?: string; // CL command name
  via?: string[]; // how it was reached: ["QCMDEXC"], ["RUNSQL"], ["alias QTEMP.A"]
  reason?: string; // why a danger or unqualified, in words for the user
  // A danger whose only cause is an unqualified CL command missing from the table: observe mode
  // logs it and lets it run (execution-policy spec).
  code?: "unknown_command";
}

export interface Lookups {
  // The system name of a long SQL schema name, or undefined if there is none.
  systemSchema(schema: string): Promise<string | undefined>;
  // Base tables of an alias or view; [] for a table. Throws when the lookup cannot be made.
  baseTables(object: { lib: string; name: string }): Promise<{ lib: string; name: string }[]>;
  // The job's current library.
  currentLibrary(): Promise<string | undefined>;
}

export interface ClassifyContext {
  lookups: Lookups;
  // RDB names a partition lists, upper case, mapped to that partition's name. Anything else
  // reached by three-part name, CONNECT or RDB() is danger.
  rdbs?: Record<string, string>;
  // The merged command table; the shipped table when omitted.
  commands?: import("./commands.js").CommandTable;
}

export interface Statement {
  kind: "sql" | "cl";
  text: string; // as written (CL: continuation lines folded, the `CL:` prefix removed)
  display: string; // comments stripped, for a confirmation
  error?: string; // a lexing error; the statement classifies as danger
}

export interface ClassifiedStatement extends Statement {
  operations: Operation[];
}

export interface Classification {
  statements: ClassifiedStatement[];
  operations: Operation[]; // every statement's, in order
  notes: string[]; // lookup failures and other things the run log should record
}
