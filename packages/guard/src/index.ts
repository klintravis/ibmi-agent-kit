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
export { decide, detectPartition, environmentOf, rolesOf } from "./decide.js";
export type { Decision, Identity, OperationDecision, RoleSource } from "./decide.js";
export { bindArgs, callArgs, loadVerbs, MAX_VERB_DEPTH, resolveVerb, substitute } from "./verbs.js";
export type { CleanupStep, Layer, SetupStep, Substituted, TemplateKind, Value, Values, Verb, VerbParam, VerbSet, VerbSources, VerbStep } from "./verbs.js";
export { decidePlans, decideVerb, isPlannedVerb, plannedStatements, planVerb } from "./verbplan.js";
export type { DecidedStatement, Planned, PlannedRole, PlannedVerb } from "./verbplan.js";
export { RunLog,recordLookups, redact, runLogLines, statedLookups, statementRule } from "./runlog.js";
export type { Answers, CallRecord, LoggedOperation, PartitionNames, RunLogLine, ToolStatement } from "./runlog.js";
export { decideStatements, describeFailure, loadPolicyTests, parsePolicyTests, replayRunLog, runPolicyTests } from "./offline.js";
export type { PolicyTest, ReplayChange, ReplayOutcome, TestResult } from "./offline.js";
