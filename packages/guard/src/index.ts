// @ibmi-agent-kit/guard: the pure half of the execution guard (design D1). The server supplies
// the lookups and does all I/O.
export { classify, classifyCl } from "./classify.js";
export { splitScript, stripClComments } from "./lexer.js";
export type { SplitStatement, SqlStatement, ClStatement, Token, TokenType } from "./lexer.js";
export { parseCl, splitTop } from "./cl.js";
export type { ClParsed } from "./cl.js";
export {
  builtinCommands,
  commandEntrySchema,
  commandFileSchema,
  commandTableSchema,
  customClasses,
  mergeCommands,
  paramSpecs,
  parseCommandFile,
} from "./commands.js";
export type { CommandEntry, CommandTable, ParamSpec } from "./commands.js";
export { BUILTINS, CATALOG_TABLE_FUNCTIONS } from "./builtins.js";
export { BUILTIN_CLASSES } from "./types.js";
export type {
  BuiltinClass,
  Classification,
  ClassifiedStatement,
  ClassifyContext,
  Lookups,
  ObjectRef,
  OpClass,
  Operation,
  Statement,
} from "./types.js";
export { BUILTIN_POLICY, builtinPolicy, loadPolicy, parsePolicy } from "./policy.js";
export type { Mode, Policy, Rule, Verdict } from "./policy.js";
export { detectPartition, environmentOf, rolesOf } from "./decide.js";
export type { Identity } from "./decide.js";
