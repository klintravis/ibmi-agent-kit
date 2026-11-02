// Table-driven checks for the classifier. One row per scenario in
// openspec/changes/execution-guard/specs/statement-classification/spec.md (named after it), then
// the bypasses from the design reviews, then the rest of the surface. No live IBM i: lookups are
// stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindArgs,
  builtinCommands,
  callArgs,
  MAX_VERB_DEPTH,
  classify,
  classifyCl,
  builtinPolicy,
  customClasses,
  decide,
  detectPartition,
  environmentOf,
  loadPolicy,
  loadVerbs,
  decidePlans,
  decideVerb,
  plannedStatements,
  planVerb,
  mergeCommands,
  parsePolicy,
  resolveVerb,
  rolesOf,
  parseCommandFile,
  splitScript,
  substitute,
  type Classification,
  type ClassifyContext,
  type CommandTable,
  type Identity,
  type Lookups,
  type Operation,
  type VerbParam,
  type VerbSources,
  describeFailure,
  loadPolicyTests,
  parsePolicyTests,
  runPolicyTests,
  RunLog,
  recordLookups,
  redact,
  replayRunLog,
  runLogLines,
  statedLookups,
  type RunLogLine,
  type ToolStatement,
} from "./index.js";

// --- helpers ---

interface Stub {
  schemas?: Record<string, string>;
  bases?: Record<string, { lib: string; name: string }[]>;
  basesThrow?: boolean;
  curlib?: string | null;
}
function lookups(s: Stub = {}): Lookups {
  return {
    systemSchema: async (schema) => s.schemas?.[schema],
    baseTables: async ({ lib, name }) => {
      if (s.basesThrow) throw new Error("not authorised to QSYS2.SYSTABLES");
      return s.bases?.[`${lib}.${name}`] ?? [];
    },
    currentLibrary: async () => {
      if (s.curlib === null) throw new Error("no connection");
      return s.curlib ?? "JDOE";
    },
  };
}

// "write B.X", "ddl lib B", "read QARDB.QTORD.T @qa", "call MYFN env=unqualified", "promote_qa"
function show(op: Operation): string {
  const o = op.object;
  let s = String(op.class);
  if (o) s += " " + (o.type === "*LIB" ? `lib ${o.lib ?? o.name}` : [o.rdb, o.lib, o.name].filter(Boolean).join("."));
  if (op.env) s += ` env=${op.env}`;
  if (op.partition) s += ` @${op.partition}`;
  return s;
}
const sorted = (ops: Operation[]) => ops.map(show).sort();
const classes = (r: Classification) => r.operations.map((o) => String(o.class));

const CM: CommandTable = {
  CMPRM: { class_by_param: { param: "LEVEL", values: { QA: "promote_qa", PROD: "promote_prod" }, default: "danger" }, positional: ["REQ", "LEVEL"] },
};
const withCm = () => mergeCommands(builtinCommands(), CM);

interface Row {
  name: string;
  script?: string; // classify()
  command?: string; // classifyCl()
  stub?: Stub;
  ctx?: Partial<ClassifyContext>;
  ops?: string[]; // every operation, any order
  stmts?: string[][]; // per statement, any order within one
  danger?: RegExp; // exactly one operation, a danger whose reason matches
  check?: (r: Classification) => void;
}

function rows(group: string, list: Row[]): void {
  for (const row of list) {
    test(`${group}: ${row.name}`, async () => {
      const ctx: ClassifyContext = { lookups: lookups(row.stub), ...row.ctx };
      const r = row.command !== undefined ? await classifyCl(row.command, ctx) : await classify(row.script ?? "", ctx);
      if (row.ops) assert.deepEqual(sorted(r.operations), [...row.ops].sort());
      if (row.stmts) assert.deepEqual(r.statements.map((s) => sorted(s.operations)), row.stmts.map((s) => [...s].sort()));
      if (row.danger) {
        assert.deepEqual(classes(r), ["danger"], `expected one danger, got ${JSON.stringify(r.operations.map(show))}`);
        assert.match(r.operations[0].reason ?? "", row.danger);
      }
      row.check?.(r);
    });
  }
}

// --- spec scenarios (statement-classification) ---

rows("spec", [
  { name: "Semicolon inside a literal", script: "UPDATE A.T SET C = 'x;y' WHERE K = 1; SELECT * FROM A.T", stmts: [["write A.T"], ["read A.T"]] },
  { name: "Keyword in a comment", script: "SELECT * FROM A.T -- then DELETE FROM B.X", ops: ["read A.T"] },
  { name: "Write hidden in a select", script: "SELECT * FROM FINAL TABLE (DELETE FROM B.X)", ops: ["write B.X"] },
  { name: "User function in a select", script: "SELECT DEVLIB.WIPE() FROM SYSIBM.SYSDUMMY1", ops: ["call DEVLIB.WIPE", "read SYSIBM.SYSDUMMY1"] },
  {
    name: "Alias in QTEMP",
    script: "CREATE ALIAS QTEMP.A FOR LIVLIB.ORD;\nDELETE FROM QTEMP.A",
    stub: { bases: { "QTEMP.A": [{ lib: "LIVLIB", name: "ORD" }] } },
    stmts: [["ddl QTEMP.A", "read LIVLIB.ORD"], ["write QTEMP.A", "write LIVLIB.ORD"]],
  },
  {
    name: "CL through QCMDEXC",
    script: "VALUES QSYS2.QCMDEXC('DLTLIB LIB(B)')",
    ops: ["ddl lib B"],
    check: (r) => { assert.equal(r.operations[0].command, "DLTLIB"); assert.deepEqual(r.operations[0].via, ["QCMDEXC"]); },
  },
  { name: "Built command", script: "CALL QSYS2.QCMDEXC('DLT' || 'LIB B')", danger: /built at run time/ },
  { name: "Procedure that writes elsewhere", script: "CREATE PROCEDURE A.P () LANGUAGE SQL BEGIN DELETE FROM B.X; END", ops: ["ddl A.P", "write B.X"] },
  { name: "Unqualified update", script: "UPDATE T SET C = 1", ops: ["unqualified T"], check: (r) => assert.match(r.operations[0].reason ?? "", /name the library/) },
  { name: "Current library compile", script: "CL: CRTBNDRPG PGM(*CURLIB/HELLO) SRCFILE(JDOE/QRPGLESRC)", stub: { curlib: "JDOE" }, ops: ["compile JDOE.HELLO", "read JDOE.QRPGLESRC"] },
  {
    name: "Long schema name",
    script: "DELETE FROM ORDER_HISTORY.T",
    stub: { schemas: { ORDER_HISTORY: "ORDER00001" } },
    ops: ["write ORDER00001.T"],
    check: (r) => assert.equal(r.operations[0].object?.schema, "ORDER_HISTORY"),
  },
  { name: "Unmapped remote insert", script: "INSERT INTO OTHERRDB.LIB.T VALUES (1)", danger: /OTHERRDB is another database/ },
  { name: "Mapped remote read", script: "SELECT * FROM QARDB.QTORD.T", ctx: { rdbs: { QARDB: "qa" } }, ops: ["read QARDB.QTORD.T @qa"] },
  { name: "Display with an outfile", script: "CL: DSPOBJD OBJ(A/*ALL) OBJTYPE(*FILE) OUTPUT(*OUTFILE) OUTFILE(B/OUT)", ops: ["read A.*ALL", "write B.OUT"] },
  {
    name: "Promotion to another partition",
    script: "CL: PRMOBJ OBJ(X) TOLIB(QTORD)",
    ctx: { commands: mergeCommands(builtinCommands(), { PRMOBJ: { class: "promote", params: { TOLIB: { kind: "library", partition: "qa" } } } }) },
    ops: ["promote lib QTORD @qa"],
  },
  { name: "Unknown command", script: "CL: FROBCMD X", danger: /not in the command table/, check: (r) => assert.equal(r.operations[0].code, "unknown_command") },
  { name: "Look-alike command", script: "CL: MYLIB/DSPOBJD OBJ(A/X) OBJTYPE(*FILE)", danger: /not the IBM command/, check: (r) => assert.equal(r.operations[0].code, undefined) },
  { name: "Promote by level (QA)", script: "CL: CMPRM REQ(1234) LEVEL(QA)", ctx: { commands: withCm() }, ops: ["promote_qa"] },
  { name: "Promote by level (PROD)", script: "CL: CMPRM REQ(1234) LEVEL(PROD)", ctx: { commands: withCm() }, ops: ["promote_prod"] },
  { name: "Unlisted level", script: "CL: CMPRM REQ(1234) LEVEL(HOTFIX)", ctx: { commands: withCm() }, danger: /HOTFIX/ },
  { name: "Unparseable statement (unclosed literal)", script: "SELECT 'oops FROM A.T", danger: /could not parse: a string literal is never closed/ },
  { name: "Unparseable statement (unknown head)", script: "FROBNICATE A.T", danger: /does not start a statement/ },
  // execution-policy "Danger still blocked while observing" depends on PWRDWNSYS being danger
  { name: "Danger still blocked while observing (PWRDWNSYS is danger)", script: "CL: PWRDWNSYS OPTION(*IMMED)", danger: /whole system/ },
]);

// --- bypasses from the design reviews ---

const nest = (sql: string, levels: number) => {
  for (let i = 0; i < levels; i++) {
    const cl = `RUNSQL SQL('${sql.replace(/'/g, "''")}')`;
    sql = `CALL QSYS2.QCMDEXC('${cl.replace(/'/g, "''")}')`;
  }
  return sql;
};

rows("bypass", [
  { name: "FINAL TABLE delete", script: "SELECT * FROM FINAL TABLE (DELETE FROM B.X)", ops: ["write B.X"] },
  { name: "NEW TABLE insert", script: "SELECT * FROM NEW TABLE (INSERT INTO B.X VALUES (1))", ops: ["write B.X"] },
  { name: "OLD TABLE update", script: "SELECT * FROM OLD TABLE (UPDATE B.X SET C = 1)", ops: ["write B.X"] },
  { name: "data-change CTE", script: "WITH C AS (SELECT K FROM A.T) DELETE FROM B.X WHERE K IN (SELECT K FROM C)", ops: ["read A.T", "write B.X"] },
  { name: "QCMDEXC as a function in VALUES", script: "VALUES QSYS2.QCMDEXC('DLTLIB LIB(B)')", ops: ["ddl lib B"] },
  { name: "QCMDEXC function in a select, unqualified", script: "SELECT QCMDEXC('DLTLIB B') FROM SYSIBM.SYSDUMMY1", ops: ["ddl lib B", "read SYSIBM.SYSDUMMY1"] },
  { name: "QSYS.QCMDEXC procedure with a length", script: "CALL QSYS.QCMDEXC('CLRPFM FILE(B/X)', 0000000016.00000)", ops: ["write B.X"] },
  { name: "QCMDEXC named argument", script: "CALL QSYS2.QCMDEXC(COMMAND => 'DLTF B/X')", ops: ["ddl B.X"] },
  { name: "QCMDEXC concatenated", script: "CALL QSYS2.QCMDEXC('DLT' || 'LIB B')", danger: /built at run time/ },
  { name: "QCMDEXC variable", script: "CALL QSYS2.QCMDEXC(V_CMD)", danger: /built at run time/ },
  { name: "QCMDEXC with CONCAT()", script: "VALUES QSYS2.QCMDEXC(CONCAT('DLTLIB ', 'B'))", danger: /built at run time/ },
  { name: "QCAPCMD", script: "CALL QSYS2.QCAPCMD('DLTLIB B')", danger: /QCAPCMD/ },
  { name: "QCMDEXC running SBMJOB", script: "CALL QSYS2.QCMDEXC('SBMJOB CMD(DLTLIB LIB(B))')", danger: /SBMJOB/ },
  { name: "user function in a select", script: "SELECT DEVLIB.WIPE() FROM SYSIBM.SYSDUMMY1", ops: ["call DEVLIB.WIPE", "read SYSIBM.SYSDUMMY1"] },
  {
    name: "QTEMP alias resolved by the stub",
    script: "CREATE ALIAS QTEMP.A FOR LIVLIB.ORD;\nDELETE FROM QTEMP.A",
    stub: { bases: { "QTEMP.A": [{ lib: "LIVLIB", name: "ORD" }] } },
    stmts: [["ddl QTEMP.A", "read LIVLIB.ORD"], ["write QTEMP.A", "write LIVLIB.ORD"]],
  },
  {
    name: "QTEMP alias the box cannot know yet (script-local)",
    script: "CREATE ALIAS QTEMP.A FOR LIVLIB.ORD;\nDELETE FROM QTEMP.A",
    stmts: [["ddl QTEMP.A", "read LIVLIB.ORD"], ["write QTEMP.A", "write LIVLIB.ORD"]],
  },
  {
    name: "an alias over a blocked library shows the library it exposes",
    script: "CREATE ALIAS QTEMP.A FOR PAYLIB.EMP;\nSELECT * FROM QTEMP.A",
    stmts: [["ddl QTEMP.A", "read PAYLIB.EMP"], ["read QTEMP.A"]],
  },
  {
    name: "a -- comment in SQL nested in CL ends at its newline",
    script: "CALL QSYS2.QCMDEXC('RUNSQL SQL(''SELECT 1 FROM A.T --x\nDELETE FROM B.X'')')",
    ops: ["read A.T", "write B.X"],
  },
  { name: "SQL CALL of a shell program", script: "CALL QSYS.QP2SHELL('/QOpenSys/usr/bin/sh', '-c', 'rm -rf /home')", danger: /QP2SHELL/ },
  { name: "CL CALL of a shell program", script: "CL: CALL PGM(QSYS/QP2SHELL) PARM('/QOpenSys/usr/bin/sh')", danger: /QP2SHELL/ },
  {
    name: "view created in the script",
    script: "CREATE VIEW QTEMP.V AS SELECT * FROM LIVLIB.ORD;\nUPDATE QTEMP.V SET C = 1",
    stmts: [["ddl QTEMP.V", "read LIVLIB.ORD"], ["write QTEMP.V", "write LIVLIB.ORD"]],
  },
  { name: "delimited mixed-case names", script: `DELETE FROM "Livlib"."Ord"`, ops: ["write LIVLIB.ORD"] },
  { name: "unqualified UPDATE", script: "UPDATE T SET C=1", ops: ["unqualified T"] },
  { name: "SET SCHEMA does not qualify a later change", script: "SET SCHEMA X; DELETE FROM T", stmts: [["liblist lib X"], ["unqualified T"]] },
  { name: "three-part insert to an unmapped RDB", script: "INSERT INTO OTHERRDB.LIB.T VALUES 1", danger: /OTHERRDB/ },
  { name: "CONNECT to an unmapped RDB", script: "CONNECT TO OTHERRDB", danger: /OTHERRDB is another database/ },
  { name: "SET CONNECTION to an unmapped RDB", script: "SET CONNECTION OTHERRDB", danger: /OTHERRDB/ },
  {
    name: "CONNECT to a mapped RDB moves later statements there",
    script: "CONNECT TO QARDB; DELETE FROM QTORD.T; CONNECT RESET; DELETE FROM DVLIB.T",
    ctx: { rdbs: { QARDB: "qa" } },
    stmts: [[], ["write QARDB.QTORD.T @qa"], [], ["write DVLIB.T"]],
  },
  { name: "DSPOBJD outfile is a write", script: "CL: DSPOBJD OBJ(A/*ALL) OBJTYPE(*FILE) OUTPUT(*OUTFILE) OUTFILE(B/OUT)", ops: ["read A.*ALL", "write B.OUT"] },
  { name: "CLRPFM", script: "CL: CLRPFM FILE(B/X)", ops: ["write B.X"] },
  { name: "positional DLTF", script: "CL: DLTF B/X", ops: ["ddl B.X"] },
  { name: "look-alike DSPOBJD", script: "CL: MYLIB/DSPOBJD OBJ(A/X) OBJTYPE(*FILE)", danger: /MYLIB\/DSPOBJD/ },
  { name: "SBMJOB is always danger", script: "CL: SBMJOB CMD(DLTLIB LIB(B))", danger: /another job/ },
  { name: "RUNSQL SQL is classified as its statement", script: "CL: RUNSQL SQL('DELETE FROM B.X')", ops: ["write B.X"], check: (r) => assert.deepEqual(r.operations[0].via, ["RUNSQL"]) },
  { name: "RUNSQL literal with escaped quotes", script: "CL: RUNSQL SQL('DELETE FROM B.X WHERE C = ''a''')", ops: ["write B.X"] },
  { name: "RUNSQL with a variable", script: "CL: RUNSQL SQL(&STMT)", danger: /CL variable/ },
  {
    name: "RUNSQL running QCMDEXC",
    script: "CL: RUNSQL SQL('CALL QSYS2.QCMDEXC(''DLTLIB LIB(B)'')')",
    ops: ["ddl lib B"],
    check: (r) => assert.deepEqual(r.operations[0].via, ["RUNSQL", "QCMDEXC"]),
  },
  { name: "nesting inside the cap", script: nest("DELETE FROM B.X", 1), ops: ["write B.X"] },
  { name: "nesting past the cap", script: nest("DELETE FROM B.X", 3), danger: /nested more than/ },
  { name: "CMPRM LEVEL(QA) by class_by_param", script: "CL: CMPRM REQ(1234) LEVEL(QA)", ctx: { commands: withCm() }, ops: ["promote_qa"] },
  { name: "CMPRM LEVEL(HOTFIX)", script: "CL: CMPRM REQ(1234) LEVEL(HOTFIX)", ctx: { commands: withCm() }, danger: /HOTFIX/ },
  { name: "CL CALL is a call on its library", script: "CL: CALL PGM(LIB/PGM)", ops: ["call LIB.PGM"] },
  { name: "CL CALL of QCMDEXC", script: "CL: CALL PGM(QSYS/QCMDEXC) PARM('DLTLIB B' 8)", danger: /QCMDEXC/ },
  { name: "CL CALL of QCMD, positional", script: "CL: CALL QCMD", danger: /QCMD/ },
  { name: "write hidden in a comment", script: "SELECT 1 FROM A.T -- DELETE FROM B.X", ops: ["read A.T"] },
  { name: "comment opener inside a literal hides nothing", script: "SELECT '/*' FROM A.T; DELETE FROM B.X -- */", stmts: [["read A.T"], ["write B.X"]] },
  { name: "semicolon inside a literal", script: "SELECT * FROM A.T WHERE C = 'a;DELETE FROM B.X'", ops: ["read A.T"] },
  { name: "semicolon smuggled into one statement", script: "SELECT 1 AS CASE FROM A.T; DELETE FROM B.X", danger: /CASE without its END|semicolon inside one statement/ },
  { name: "nested block comment refused", script: "/* a /* b */ DELETE FROM B.X */ SELECT 1 FROM A.T", danger: /contains another/ },
  { name: "keyword-named schema written", script: "UPDATE DATA.T SET C = 1", ops: ["write DATA.T"] },
  { name: "keyword-named schema function", script: "SELECT LABEL.WIPE() FROM SYSIBM.SYSDUMMY1", ops: ["call LABEL.WIPE", "read SYSIBM.SYSDUMMY1"] },
  { name: "EXECUTE IMMEDIATE", script: "EXECUTE IMMEDIATE 'DELETE FROM B.X'", danger: /run time/ },
  { name: "PREPARE", script: "PREPARE S FROM 'DELETE FROM B.X'", danger: /does not start|run time/ },
  {
    name: "EXECUTE IMMEDIATE in a routine body",
    script: "CREATE PROCEDURE A.P (IN S VARCHAR(100)) BEGIN EXECUTE IMMEDIATE S; END",
    check: (r) => assert.ok(classes(r).includes("danger")),
  },
  { name: "column named LAST does not hide FROM", script: "SELECT FIRST, LAST FROM PAYLIB.EMP", ops: ["read PAYLIB.EMP"] },
]);

// --- the lexer and splitter (task 1.2) ---

test("lexer: semicolons in literals and delimited names do not split", () => {
  assert.equal(splitScript("UPDATE A.T SET C = 'x;y' WHERE K = 1; SELECT * FROM A.T").length, 2);
  assert.equal(splitScript(`SELECT "a;b" FROM A.T; SELECT 1 FROM A.U`).length, 2);
  assert.equal(splitScript("SELECT * FROM A.T WHERE C = 'it''s; fine'").length, 1);
});

test("lexer: comments are not code and are stripped for display", () => {
  const s = splitScript("/* DELETE FROM B.X; */ SELECT * FROM A.T -- note\nWHERE 1 = 1");
  assert.equal(s.length, 1);
  assert.equal(s[0].display, "SELECT * FROM A.T\nWHERE 1 = 1");
  assert.ok(s[0].text.includes("-- note"), "the text sent keeps what was written");
});

test("lexer: CL: lines in any case, with + continuation", () => {
  const s = splitScript("SELECT 1 FROM A.T\ncl: dltf b/x\nCl: DSPOBJD OBJ(A/X) +\n      OBJTYPE(*FILE) /* note */\nSELECT 2 FROM A.U;");
  assert.deepEqual(s.map((x) => x.kind), ["sql", "cl", "cl", "sql"]);
  assert.equal(s[1].text, "dltf b/x");
  assert.equal(s[2].text, "DSPOBJD OBJ(A/X) OBJTYPE(*FILE) /* note */");
  assert.equal(s[2].display, "DSPOBJD OBJ(A/X) OBJTYPE(*FILE)");
});

test("lexer: CRLF line ends", async () => {
  const script = "SELECT 1 FROM A.T;\r\nCL: DSPOBJD OBJ(A/X) +\r\n   OBJTYPE(*FILE)\r\nDELETE FROM B.X -- gone\r\n";
  const s = splitScript(script);
  assert.deepEqual(s.map((x) => x.kind), ["sql", "cl", "sql"]);
  assert.equal(s[1].text, "DSPOBJD OBJ(A/X) OBJTYPE(*FILE)");
  assert.equal(s[2].display, "DELETE FROM B.X");
  const r = await classify(script, { lookups: lookups() });
  assert.deepEqual(r.statements.map((x) => sorted(x.operations)), [["read A.T"], ["read A.X"], ["write B.X"]]);
});

test("lexer: a routine body stays one statement", () => {
  const s = splitScript("CREATE PROCEDURE A.P () BEGIN IF 1 = 1 THEN DELETE FROM B.X; END IF; CASE WHEN 1 = 1 THEN SET V = 1; END CASE; END; SELECT 1 FROM A.T");
  assert.equal(s.length, 2);
  assert.match(s[1].text, /^SELECT 1/);
});

test("lexer: an unclosed BEGIN is reported, not guessed", () => {
  const s = splitScript("BEGIN DELETE FROM B.X;");
  assert.equal(s.length, 1);
  assert.match(s[0].error ?? "", /BEGIN or CASE without its END/);
});

// --- SQL classification (task 1.3) ---

rows("sql", [
  { name: "system naming", script: "DELETE FROM B/X; SELECT * FROM A/T", stmts: [["write B.X"], ["read A.T"]] },
  { name: "unqualified read is in environment unqualified", script: "SELECT * FROM T", ops: ["read T env=unqualified"] },
  { name: "unqualified function is a call in environment unqualified", script: "SELECT MYFN(C) FROM A.T", ops: ["call MYFN env=unqualified", "read A.T"] },
  {
    name: "built-in functions are not calls",
    script: "SELECT SUBSTR(C, 1, 2), COALESCE(D, 0), VARCHAR_FORMAT(TS, 'YYYY'), EXTRACT(YEAR FROM TS), TRIM(LEADING '0' FROM C), COUNT(*) FROM A.T",
    ops: ["read A.T"],
  },
  { name: "a QSYS2 scalar service is a call on QSYS2", script: "SELECT QSYS2.DELIMIT_NAME('a') FROM SYSIBM.SYSDUMMY1", ops: ["call QSYS2.DELIMIT_NAME", "read SYSIBM.SYSDUMMY1"] },
  { name: "a catalog table function in FROM is a read", script: "SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS('A', '*FILE')) X, B.T Y", ops: ["read QSYS2.OBJECT_STATISTICS", "read B.T"] },
  { name: "IFS_READ is a call", script: "SELECT * FROM TABLE(QSYS2.IFS_READ('/home/x/.ssh/id_rsa'))", ops: ["call QSYS2.IFS_READ"] },
  { name: "a catalog function outside FROM TABLE is a call", script: "VALUES (SELECT COUNT(*) FROM SYSIBM.SYSDUMMY1), QSYS2.OBJECT_STATISTICS('A', '*FILE')", ops: ["call QSYS2.OBJECT_STATISTICS", "read SYSIBM.SYSDUMMY1"] },
  { name: "joins and comma lists", script: "SELECT * FROM A.T X JOIN A.U Y ON X.K = Y.K LEFT JOIN A.V ON 1 = 1, A.W", ops: ["read A.T", "read A.U", "read A.V", "read A.W"] },
  {
    name: "MERGE",
    script: "MERGE INTO A.T T USING B.S S ON T.K = S.K WHEN MATCHED THEN UPDATE SET C = S.C WHEN NOT MATCHED THEN INSERT (K, C) VALUES (S.K, S.C)",
    ops: ["write A.T", "read B.S"],
  },
  { name: "INSERT ... SELECT", script: "INSERT INTO JDOE.T (A, B) SELECT A, B FROM LIVLIB.X", ops: ["write JDOE.T", "read LIVLIB.X"] },
  { name: "TRUNCATE and LOCK", script: "TRUNCATE TABLE A.T; LOCK TABLE A.U IN EXCLUSIVE MODE", stmts: [["write A.T"], ["write A.U"]] },
  { name: "sequence NEXT VALUE is a write", script: "VALUES NEXT VALUE FOR A.SEQ", ops: ["write A.SEQ"] },
  { name: "SET of a global variable", script: "SET APP.GV = (SELECT MAX(K) FROM A.T)", ops: ["write APP.GV", "read A.T"] },
  { name: "SET PATH is a library-list change", script: "SET PATH = MYLIB, QSYS2", ops: ["liblist"] },
  { name: "SET SESSION AUTHORIZATION", script: "SET SESSION AUTHORIZATION QSECOFR", danger: /session user/ },
  { name: "harmless statements have no operations", script: "COMMIT; SET CURRENT DEGREE = 'ANY'; VALUES 1; ROLLBACK", stmts: [[], [], [], []] },
  { name: "SET of an unknown register", script: "SET CURRENT FROBNITZ = 1", danger: /not a statement the guard recognises/ },
  { name: "CREATE TABLE", script: "CREATE TABLE A.T (C INT, D CHAR(10) NOT NULL WITH DEFAULT, E TIMESTAMP NOT NULL GENERATED ALWAYS FOR EACH ROW ON UPDATE AS ROW CHANGE TIMESTAMP, PRIMARY KEY (C))", ops: ["ddl A.T"] },
  { name: "CREATE TABLE AS and LIKE", script: "CREATE TABLE A.T AS (SELECT * FROM B.U) WITH DATA; CREATE TABLE A.V LIKE B.W", stmts: [["ddl A.T", "read B.U"], ["ddl A.V", "read B.W"]] },
  { name: "CREATE INDEX", script: "CREATE UNIQUE INDEX A.I ON B.T (C, D)", ops: ["ddl A.I", "read B.T"] },
  { name: "CREATE and DROP SCHEMA", script: "CREATE SCHEMA NEWLIB; DROP SCHEMA OLDLIB CASCADE", stmts: [["ddl lib NEWLIB"], ["ddl lib OLDLIB"]] },
  { name: "DROP TABLE IF EXISTS, DROP FUNCTION signature", script: "DROP TABLE IF EXISTS A.T; DROP FUNCTION A.F (INT, CHAR(10))", stmts: [["ddl A.T"], ["ddl A.F"]] },
  { name: "ALTER TABLE clauses are not statements", script: "ALTER TABLE A.T DROP COLUMN C", ops: ["ddl A.T"] },
  { name: "ALTER TABLE foreign key", script: "ALTER TABLE A.T ADD CONSTRAINT F FOREIGN KEY (C) REFERENCES B.U (K) ON DELETE CASCADE", ops: ["ddl A.T", "read B.U"] },
  { name: "RENAME", script: "RENAME TABLE A.T TO U", ops: ["ddl A.T"] },
  { name: "GRANT with a column list", script: "GRANT SELECT, UPDATE (C) ON A.T TO PUBLIC", ops: ["ddl A.T"] },
  { name: "REVOKE FROM a user is not a table", script: "REVOKE ALL ON TABLE A.T, A.U FROM JDOE", ops: ["ddl A.T", "ddl A.U"] },
  { name: "GRANT on a procedure", script: "GRANT EXECUTE ON PROCEDURE A.P TO PUBLIC", ops: ["ddl A.P"] },
  { name: "COMMENT ON COLUMN and LABEL ON", script: "COMMENT ON COLUMN A.T.C IS 'x'; LABEL ON TABLE A.U IS 'y'; COMMENT ON A.V (C IS 'z')", stmts: [["ddl A.T"], ["ddl A.U"], ["ddl A.V"]] },
  { name: "declared temporary table", script: "DECLARE GLOBAL TEMPORARY TABLE SESSION.W AS (SELECT * FROM A.T) WITH DATA; INSERT INTO SESSION.W VALUES (1)", stmts: [["ddl QTEMP.W", "read A.T"], ["write QTEMP.W"]] },
  {
    name: "trigger events are not writes; the subject table is changed",
    script: "CREATE TRIGGER A.TR AFTER INSERT OR UPDATE OF C ON A.T REFERENCING NEW AS N FOR EACH ROW MODE DB2ROW BEGIN ATOMIC INSERT INTO B.LOG VALUES (N.C); END",
    ops: ["ddl A.TR", "ddl A.T", "write B.LOG"],
  },
  {
    name: "function body",
    script: "CREATE OR REPLACE FUNCTION A.F (P INT) RETURNS INT LANGUAGE SQL MODIFIES SQL DATA BEGIN UPDATE B.X SET C = P; RETURN P; END",
    ops: ["ddl A.F", "write B.X"],
  },
  {
    name: "cursor FETCH reads nothing extra",
    script: "CREATE PROCEDURE A.P () BEGIN DECLARE V INT; DECLARE C1 CURSOR FOR SELECT K FROM A.T; OPEN C1; FETCH NEXT FROM C1 INTO V; CLOSE C1; END",
    ops: ["ddl A.P", "read A.T"],
  },
  { name: "external procedure", script: "CREATE PROCEDURE A.P (IN X INT) LANGUAGE RPGLE EXTERNAL NAME A/PGM(ENTRY)", ops: ["ddl A.P"] },
  { name: "unknown CREATE", script: "CREATE NICKNAME A.N FOR X.Y", danger: /CREATE NICKNAME/ },
  { name: "a change verb with nothing to act on", script: "UPDATE SET C = 1", danger: /could not read/ },
  {
    name: "view base tables from the box",
    script: "UPDATE APP.V SET C = 1",
    stub: { bases: { "APP.V": [{ lib: "LIVLIB", name: "ORD" }, { lib: "LIVLIB", name: "LIN" }] } },
    ops: ["write APP.V", "write LIVLIB.ORD", "write LIVLIB.LIN"],
    check: (r) => assert.deepEqual(r.operations[1].via, ["alias or view APP.V"]),
  },
  {
    name: "a failed alias/view lookup fails closed as danger, and is noted",
    script: "DELETE FROM LIVLIB.V",
    stub: { basesThrow: true },
    ops: ["write LIVLIB.V", "danger LIVLIB.V"],
    check: (r) => assert.match(r.operations[1].reason ?? "", /^could not resolve alias\/view bases of LIVLIB\.V: not authorised/),
  },
  {
    name: "a long schema with no system name is noted",
    script: "DELETE FROM ORDER_HISTORY.T",
    ops: ["write ORDER_HISTORY.T"],
    check: (r) => assert.match(r.notes.join("\n"), /no system name found for schema ORDER_HISTORY/),
  },
  { name: "three-part write to a mapped RDB", script: "DELETE FROM QARDB.QTORD.T", ctx: { rdbs: { qardb: "qa" } }, ops: ["write QARDB.QTORD.T @qa"] },
  { name: "DISCONNECT an unmapped RDB", script: "DISCONNECT OTHERRDB", danger: /OTHERRDB/ },
]);

// --- source's assertSelectOnly, against the classifier ---
// Every statement run_sql's regex guard refuses for what it does is not read-only here. Left out on
// purpose: its comment and literal-semicolon refusals (parsed now, by design), the two slow catalog
// views and IBMI_BLOCKED_TABLES (separate checks the engine keeps), and `values 1` and `begin end`,
// which do nothing and classify as no operation.
const REFUSED = [
  "insert into mylib.myfile values (1)", "update mylib.myfile set a = 1", "delete from mylib.myfile",
  "merge into mylib.myfile using x on 1 = 1 when matched then delete", "drop table mylib.myfile",
  "create table mylib.x (a int)", "alter table mylib.myfile add column b int",
  "grant select on mylib.myfile to public", "revoke select on mylib.myfile from public",
  "comment on table mylib.myfile is 'x'", "label on table mylib.myfile is 'x'", "call mylib.myproc()",
  "set schema mylib", "lock table mylib.myfile in exclusive mode", "rename table mylib.myfile to x",
  "truncate table mylib.myfile", "declare global temporary table t (a int)", "selectx from t",
  "without c as (select 1) select 1",
  "select * from final table (insert into mylib.myfile values (1))",
  "select * from new table (insert into mylib.myfile values (1))",
  "select * from old table (delete from mylib.myfile)",
  "select * from final  table(insert into mylib.myfile values (1))",
  "select * from final\ntable (insert into mylib.myfile values (1))",
  "with c as (select 1 as n from sysibm.sysdummy1) insert into mylib.myfile select n from c",
  "with c as (select 1 as n from sysibm.sysdummy1) delete from mylib.myfile",
  "with c as (select 1 as n from sysibm.sysdummy1) update mylib.myfile set a = 1",
  "with c as (select 1 as n from sysibm.sysdummy1) merge into mylib.myfile using c on 1 = 1 when matched then delete",
  "select qsys2.qcmdexc('dltlib mylib') from sysibm.sysdummy1",
  "select qsys2.qcmdexc\n('dltlib mylib') from sysibm.sysdummy1",
  "select systools.httpgetclob('http://example.com', '') from sysibm.sysdummy1",
  "select * from table(qsys2.ifs_read('/home/myuser/.ssh/id_rsa'))",
  "select 1 from sysibm.sysdummy1; delete from mylib.myfile",
  "select * from final/**/table(insert into mylib.myfile values (1))",
];

test("everything assertSelectOnly refuses for what it does is not read-only", async () => {
  for (const sql of REFUSED) {
    const r = await classify(sql, { lookups: lookups() });
    assert.ok(r.operations.some((o) => o.class !== "read"), `${JSON.stringify(sql)} classified read-only: ${JSON.stringify(r.operations.map(show))}`);
  }
});

test("the select shapes run_sql exists for stay read-only", async () => {
  for (const sql of [
    "select * from MYLIB.MYFILE",
    "select * from mylib/myfile",
    "select objname from table(qsys2.object_statistics('MYLIB', '*FILE'))",
    "select sql_name from table(systools.related_objects(library_name => 'MYLIB', file_name => 'MYFILE'))",
    "with c as (select 1 as n from sysibm.sysdummy1) select * from c",
    "(select 1 from sysibm.sysdummy1) union (select 2 from sysibm.sysdummy1)",
    "SeLeCt 1 from sysibm.sysdummy1",
    "select * from MYLIB.MYFILE fetch first 5 rows only",
    "select * from MYLIB.MYFILE with ur",
    "select http_status from mylib.mylog",
  ]) {
    const r = await classify(sql, { lookups: lookups() });
    assert.ok(r.operations.length > 0 && r.operations.every((o) => o.class === "read" && !o.env), `${JSON.stringify(sql)}: ${JSON.stringify(r.operations.map(show))}`);
  }
});

// --- CL classification and the command table (task 1.4) ---

const cmLib = () => mergeCommands(builtinCommands(), { CMPRM: { ...CM.CMPRM, library: "CMLIB" } });

rows("cl", [
  { name: "QSYS-qualified IBM command", script: "CL: QSYS/DLTF B/X", ops: ["ddl B.X"] },
  { name: "unknown command", script: "CL: FROBCMD X", danger: /not in the command table/, check: (r) => assert.equal(r.operations[0].code, "unknown_command") },
  { name: "unknown command qualified *LIBL", script: "CL: *LIBL/FROBCMD X", danger: /not in the command table/, check: (r) => assert.equal(r.operations[0].code, "unknown_command") },
  { name: "unknown command qualified *NLVLIBL", script: "CL: *NLVLIBL/FROBCMD X", danger: /not in the command table/, check: (r) => assert.equal(r.operations[0].code, "unknown_command") },
  { name: "unknown command qualified to a library keeps the qualifier reason", script: "CL: MYLIB/FROBCMD X", danger: /MYLIB\/FROBCMD is not the IBM command/, check: (r) => assert.equal(r.operations[0].code, undefined) },
  { name: "unknown command qualified QSYS is not unknown_command", script: "CL: QSYS/FROBCMD X", danger: /QSYS\/FROBCMD is not in the command table/, check: (r) => assert.equal(r.operations[0].code, undefined) },
  { name: "unknown command with a CL variable stays a variable danger", script: "CL: FROBCMD &X", danger: /CL variable/, check: (r) => assert.equal(r.operations[0].code, undefined) },
  { name: "*NLVLIBL-qualified IBM command", script: "CL: *NLVLIBL/DSPOBJD OBJ(A/X) OBJTYPE(*FILE)", ops: ["read A.X"] },
  { name: "*LIBL change is unqualified", script: "CL: CLRPFM FILE(*LIBL/X)", ops: ["unqualified X"] },
  { name: "bare change is unqualified", script: "CL: CLRPFM X", ops: ["unqualified X"] },
  { name: "*LIBL read is in environment unqualified", script: "CL: DSPPFM FILE(X)", ops: ["read X env=unqualified"] },
  { name: "generic library is unqualified", script: "CL: DLTF FILE(LIV*/X)", ops: ["unqualified LIV*/X"], check: (r) => assert.match(r.operations[0].reason ?? "", /more than one/) },
  { name: "*CURLIB that cannot be resolved", script: "CL: DLTF FILE(*CURLIB/X)", stub: { curlib: null }, ops: ["unqualified X"], check: (r) => assert.match(r.notes.join(), /current library lookup failed/) },
  { name: "*CURLIB library parameter", script: "CL: CLRLIB LIB(*CURLIB)", stub: { curlib: "JDOE" }, ops: ["ddl lib JDOE"] },
  {
    name: "*CURLIB after CHGCURLIB earlier in the script is unqualified; before it, resolved",
    script: "CL: CLRPFM FILE(*CURLIB/A)\nCL: CHGCURLIB LVORD\nCL: CLRPFM FILE(*CURLIB/ORDERS)",
    stub: { curlib: "JDOE" },
    stmts: [["write JDOE.A"], ["liblist lib LVORD"], ["unqualified ORDERS"]],
    check: (r) => assert.equal(r.statements[2].operations[0].reason, "the script changes the current library; name the library"),
  },
  {
    name: "*CURLIB after CHGLIBL CURLIB() earlier in the script is unqualified",
    script: "CL: CHGLIBL LIBL(A) CURLIB(LVORD)\nCL: CLRPFM FILE(*CURLIB/ORDERS)",
    stub: { curlib: "JDOE" },
    stmts: [["liblist lib A", "liblist lib LVORD"], ["unqualified ORDERS"]],
  },
  {
    name: "*CURLIB after CHGCURLIB through QCMDEXC is unqualified",
    script: "CALL QSYS2.QCMDEXC('CHGCURLIB LVORD');\nCL: CLRPFM FILE(*CURLIB/ORDERS)",
    stub: { curlib: "JDOE" },
    stmts: [["liblist lib LVORD"], ["unqualified ORDERS"]],
    check: (r) => assert.match(r.statements[1].operations[0].reason ?? "", /changes the current library/),
  },
  { name: "a parameter naming another (*FROMLIB)", script: "CL: CRTDUPOBJ OBJ(X) FROMLIB(A) OBJTYPE(*FILE) TOLIB(*FROMLIB) NEWOBJ(Y)", ops: ["ddl lib A", "read lib A"] },
  { name: "copy reads one file and writes another", script: "CL: CPYF FROMFILE(LIVLIB/ORD) TOFILE(JDOE/ORD) MBROPT(*REPLACE)", ops: ["read LIVLIB.ORD", "write JDOE.ORD"] },
  { name: "binding directory entries: the directory is ddl, each bound object read", script: "CL: ADDBNDDIRE BNDDIR(A/BD) OBJ((A/S *SRVPGM) (T *MODULE))", ops: ["ddl A.BD", "read A.S", "read T env=unqualified"] },
  { name: "binding directory entries by position", script: "CL: RMVBNDDIRE A/BD ((B/S *SRVPGM))", ops: ["ddl A.BD", "read B.S"] },
  { name: "binding directory display to an outfile", script: "CL: DSPBNDDIR BNDDIR(A/BD) OUTPUT(*OUTFILE) OUTFILE(B/O)", ops: ["read A.BD", "write B.O"] },
  { name: "unqualified binding directory create", script: "CL: CRTBNDDIR BD", ops: ["unqualified BD"] },
  { name: "message description without a default program", script: "CL: ADDMSGD MSGID(USR0001) MSGF(A/MSGF) MSG('Hello') DFTPGM(*NONE)", ops: ["ddl A.MSGF"] },
  { name: "message description naming a default program is danger", script: "CL: CHGMSGD USR0001 A/MSGF DFTPGM(B/P)", ops: ["ddl A.MSGF", "danger B.P"] },
  { name: "SQL precompile writes its TOSRCFILE", script: "CL: CRTSQLCI OBJ(A/P) SRCFILE(A/QCSRC) TOSRCFILE(B/QSQLT)", ops: ["compile A.P", "read A.QCSRC", "write B.QSQLT"] },
  { name: "a positional RUNSQL list is its one statement", script: "CL: RUNSQL ('DELETE FROM A.T')", ops: ["write A.T"] },
  { name: "a positional RUNSQL list of two literals is danger", script: "CL: RUNSQL ('X' 'Y')", danger: /one quoted literal/ },
  { name: "a list given by position", script: "CL: CHGLIBL (A B C) D", ops: ["liblist lib A", "liblist lib B", "liblist lib C", "liblist lib D"] },
  { name: "library list values", script: "CL: CHGLIBL LIBL(A B C) CURLIB(D)", ops: ["liblist lib A", "liblist lib B", "liblist lib C", "liblist lib D"] },
  { name: "RDB() to an unmapped database", script: "CL: CRTSQLRPGI OBJ(A/P) SRCFILE(A/QSRC) RDB(OTHERRDB)", danger: /OTHERRDB/ },
  { name: "RDB() to a mapped database", script: "CL: CRTSQLRPGI OBJ(A/P) SRCFILE(A/QSRC) RDB(QARDB)", ctx: { rdbs: { QARDB: "qa" } }, ops: ["compile QARDB.A.P @qa", "read QARDB.A.QSRC @qa"] },
  { name: "RDB(*LOCAL) stays here", script: "CL: CRTSQLRPGI OBJ(A/P) SRCFILE(A/QSRC) RDB(*LOCAL)", ops: ["compile A.P", "read A.QSRC"] },
  { name: "prompting is danger", script: "CL: DLTF ??FILE(B/X)", danger: /prompting/ },
  { name: "a CL variable is danger", script: "CL: DLTF FILE(&F)", danger: /CL variable/ },
  { name: "too many positional values", script: "CL: DLTF B/X *YES *NO EXTRA", danger: /more positional values/ },
  { name: "a parameter given by position and by keyword", script: "CL: DLTF LIVLIB/X FILE(JDOE/X)", danger: /both by position and by keyword/ },
  { name: "unbalanced parentheses", script: "CL: DLTF FILE(B/X", danger: /never closed/ },
  { name: "a command with no object still yields one operation", script: "CL: WRKACTJOB", ops: ["read"] },
  { name: "lower case and a comment", script: "cl: clrpfm file(b/x) /* tidy */", ops: ["write B.X"] },
  { name: "class_by_param from positional values", script: "CL: CMPRM 1234 QA", ctx: { commands: withCm() }, ops: ["promote_qa"] },
  { name: "class_by_param without the parameter takes the default", script: "CL: CMPRM REQ(1234)", ctx: { commands: withCm() }, danger: /without LEVEL/ },
  { name: "library: unqualified product command", script: "CL: CMPRM REQ(1) LEVEL(QA)", ctx: { commands: cmLib() }, danger: /CMLIB\/CMPRM/ },
  { name: "library: qualified to the product library", script: "CL: CMLIB/CMPRM REQ(1) LEVEL(QA)", ctx: { commands: cmLib() }, ops: ["promote_qa"] },
  { name: "library: qualified elsewhere", script: "CL: OTHER/CMPRM REQ(1) LEVEL(QA)", ctx: { commands: cmLib() }, danger: /CMLIB/ },
  { name: "classifyCl folds + continuation", command: "DSPOBJD OBJ(A/X) +\n   OBJTYPE(*FILE)", ops: ["read A.X"] },
  { name: "classifyCl of a danger command", command: "STRQSH CMD('rm -rf /')", danger: /Qshell/ },
]);

test("command table: shipped table loads, has no custom classes, and the D3 danger list", () => {
  const t = builtinCommands();
  assert.deepEqual(customClasses(t), []);
  for (const c of ["SBMJOB", "QSH", "STRQSH", "STRREXPRC", "PWRDWNSYS", "ENDSYS", "ENDSBS", "CHGUSRPRF", "CRTUSRPRF", "DLTUSRPRF", "CHGSYSVAL", "ENDTCP", "QCAPCMD"])
    assert.equal(t[c]?.class, "danger", c);
  for (const c of ["DSPOBJD", "WRKACTJOB", "GO", "SIGNOFF", "ADDLIBLE", "CHGCURLIB", "CALL", "CRTBNDRPG", "RUNSQL"]) assert.ok(t[c], `${c} is shipped`);
});

test("command table: everyday build commands and their classes", () => {
  const t = builtinCommands();
  const want: Record<string, string> = {
    DSPBNDDIR: "read", WRKBNDDIR: "read", WRKBNDDIRE: "read", DSPMSGD: "read", WRKMSGD: "read", WRKMSGF: "read",
    CRTBNDDIR: "ddl", DLTBNDDIR: "ddl", ADDBNDDIRE: "ddl", RMVBNDDIRE: "ddl", CRTMSGF: "ddl", DLTMSGF: "ddl",
    ADDMSGD: "ddl", CHGMSGD: "ddl", RMVMSGD: "ddl", CHGPGM: "ddl", CHGSRVPGM: "ddl",
    CRTSQLCI: "compile",
  };
  for (const [c, cls] of Object.entries(want)) assert.equal(t[c]?.class, cls, c);
});

test("command table: merge replaces whole entries and custom classes are reported", () => {
  const t = mergeCommands(builtinCommands(), CM, { dltf: { class: "danger", reason: "this shop never deletes files" } });
  assert.deepEqual(customClasses(t), ["promote_prod", "promote_qa"]);
  assert.equal(t.DLTF.class, "danger");
  assert.equal(t.DLTF.positional, undefined, "an override restates the command");
});

test("command table: a command file is validated, naming the file", () => {
  const ok = parseCommandFile("commands:\n  cmprm:\n    class_by_param: { param: level, values: { qa: promote_qa }, default: danger }\n", "cm-product.yaml");
  assert.deepEqual(ok.CMPRM.class_by_param?.values, { QA: "promote_qa" });
  assert.throws(() => parseCommandFile("commands:\n  CMPRM: { clas: promote }\n", "cm-product.yaml"), /cm-product\.yaml: commands\.CMPRM.*clas/s);
  assert.throws(() => parseCommandFile("commands:\n  CMPRM: { class: Promote }\n", "cm-product.yaml"), /cm-product\.yaml/);
  assert.throws(() => parseCommandFile("commands:\n  CMPRM: { class: promote, class_by_param: { param: L, values: {}, default: danger } }\n", "x.yaml"), /exactly one of class/);
  assert.throws(() => parseCommandFile("commands: [unclosed\n", "broken.yaml"), /broken\.yaml line \d/);
  assert.throws(() => parseCommandFile("commands:\n  X: { class: read }\n  X: { class: write }\n", "dup.yaml"), /dup\.yaml/);
});

// --- policy loading (execution-policy spec; task 2.1) ---

const EXAMPLE = fileURLToPath(new URL("../../../examples/three-partitions.yaml", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "guard-policy-"));
const MINIMAL = "version: 1\nrules:\n  - { decision: allow }\n";

test("policy: the D4 example and its command file load", () => {
  const p = loadPolicy(EXAMPLE);
  assert.deepEqual(p.mode, { default: "observe", partitions: { prod: "enforce" } });
  assert.deepEqual(p.partitions.map((x) => x.name), ["dev", "qa", "prod"]);
  assert.deepEqual(p.rdbs, { DEVRDB: "dev", QARDB: "qa", QAIASP1: "qa", PRODRDB: "prod" });
  assert.equal(p.unknownPartition, "prod");
  assert.equal(p.defaultRole, "analyst");
  assert.equal(p.commands.CMPRM?.class_by_param?.values.QA, "promote_qa", "cm-product.yaml merged");
  assert.ok(p.commands.DSPOBJD, "shipped table kept");
  assert.equal(p.rules.length, 10);
  assert.deepEqual(p.rules[0], { classes: ["danger"], decision: "deny" });
  assert.deepEqual(p.rules[5], { roles: ["dev", "qa"], partition: ["dev"], env: ["personal", "devlibs", "integ"], decision: "allow" });
  assert.deepEqual(p.environments[1], { name: "personal", libraries: [], match: ["${USER}", "${USER}_*"], partitions: ["dev"] });
});

test("policy: the built-in policy loads in observe mode", () => {
  const p = builtinPolicy();
  assert.equal(p.source, "built-in");
  assert.deepEqual(p.mode, { default: "observe", partitions: {} });
  assert.deepEqual(p.rules, [{ decision: "allow" }]);
  assert.deepEqual(loadPolicy(), p);
});

test("policy: mode is a value or a per-partition map; a file without one enforces", () => {
  assert.deepEqual(parsePolicy(MINIMAL, "p.yaml").mode, { default: "enforce", partitions: {} });
  assert.deepEqual(parsePolicy("mode: observe\n" + MINIMAL, "p.yaml").mode, { default: "observe", partitions: {} });
  const m = parsePolicy("mode: { prod: observe }\npartitions: [{ name: prod, rdbs: [P] }]\nunknown_partition: prod\n" + MINIMAL, "p.yaml").mode;
  assert.deepEqual(m, { default: "enforce", partitions: { prod: "observe" } });
  assert.throws(() => parsePolicy("mode: watch\n" + MINIMAL, "p.yaml"), /p\.yaml: mode/);
});

test("policy: a typo in a key is refused naming the file and the key", () => {
  assert.throws(() => parsePolicy("version: 1\nrules:\n  - { decison: allow }\n", "team.yaml"), /team\.yaml: rules\.0: .*decison/);
  assert.throws(() => parsePolicy("version: 1\nrule: []\n", "team.yaml"), /team\.yaml: .*rule/);
});

test("policy: a missing file is refused naming the path", () => {
  const path = join(tmp(), "nope.yaml");
  assert.throws(() => loadPolicy(path), (e: Error) => e.message.includes(path));
});

test("policy: NO stays a string (YAML 1.2 core schema)", () => {
  const p = parsePolicy("version: 1\nenvironments:\n  - { name: norway, libraries: [NO] }\nrules:\n  - { env: norway, decision: allow }\n", "p.yaml");
  assert.deepEqual(p.environments[0].libraries, ["NO"]);
});

test("policy: an unquoted * names the line and says to quote it", () => {
  assert.throws(
    () => parsePolicy("version: 1\nenvironments:\n  - { name: all, match: [*ALL] }\nrules: []\n", "p.yaml"),
    /p\.yaml line 3: .*quote values starting with \*/,
  );
});

test("policy: a __proto__ key in any YAML map is refused naming the line", () => {
  // zod 4 drops a record key of that name without checking it, so parseYaml must refuse it first
  for (const body of ["commands:\n  __proto__: { bogus: 1 }\n", "mode: { __proto__: observe }\n", 'mode: { "__proto__": nope }\n'])
    assert.throws(() => parsePolicy(`version: 1\n${body}rules: []\n`, "p.yaml"), /^Error: p\.yaml line [23]: __proto__ is not allowed as a key$/, body);
  assert.throws(() => parseCommandFile("commands:\n  CMD: { class: read, params: { __proto__: object } }\n", "c.yaml"), /^Error: c\.yaml line 2: __proto__ is not allowed/);
});

test("policy: a record key that fails its pattern is named with the repo's message, through a union too", () => {
  const p = (body: string) => () => parsePolicy(`version: 1\n${body}rules: []\n`, "p.yaml");
  assert.throws(p("commands: { TOOLONGNAME12: { class: read } }\n"), /^Error: p\.yaml: commands\.TOOLONGNAME12: an IBM i name of at most 10 characters$/);
  assert.throws(p("commands: { FOO: { class: read, params: { TOOLONGNAME12: object } } }\n"), /^Error: p\.yaml: commands\.FOO\.params\.TOOLONGNAME12: an IBM i name of at most 10 characters$/);
  assert.throws(p('mode: { "bad key": observe }\n'), /^Error: p\.yaml: mode\.bad key: a name is letters, digits, _ and -$/);
  assert.throws(p("mode: { dev: nope }\n"), /^Error: p\.yaml: mode\.dev: Invalid option/);
  assert.throws(p("mode: 5\n"), /^Error: p\.yaml: mode: Invalid input$/);
});

test("policy: an error in a command file names that file", () => {
  const dir = tmp();
  writeFileSync(join(dir, "cm-product.yaml"), "commands:\n  CMPRM: { clas: promote }\n");
  writeFileSync(join(dir, "policy.yaml"), "version: 1\ncommand_files: [cm-product.yaml]\nrules: []\n");
  assert.throws(() => loadPolicy(join(dir, "policy.yaml")), /cm-product\.yaml: commands\.CMPRM.*clas/s);
  writeFileSync(join(dir, "policy.yaml"), "version: 1\ncommand_files: [missing.yaml]\nrules: []\n");
  assert.throws(() => loadPolicy(join(dir, "policy.yaml")), /policy\.yaml: command_files: .*missing\.yaml not found/);
});

test("policy: command_files merge in order, then the policy's own commands", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.yaml"), "commands:\n  FROB: { class: read }\n  ZAP: { class: write }\n");
  writeFileSync(join(dir, "b.yaml"), "commands:\n  FROB: { class: write }\n");
  writeFileSync(join(dir, "policy.yaml"), "version: 1\ncommand_files: [a.yaml, b.yaml]\ncommands:\n  zap: { class: ddl }\nrules: []\n");
  const p = loadPolicy(join(dir, "policy.yaml"));
  assert.equal(p.commands.FROB.class, "write");
  assert.equal(p.commands.ZAP.class, "ddl");
});

// --- reference checks and shadow warnings (task 2.2) ---

const PARTS = "partitions:\n  - { name: dev, systems: [DEVBOX] }\n  - { name: qa, rdbs: [QARDB] }\nunknown_partition: qa\n";

test("policy refs: a rule naming an undefined environment is refused naming the rule and the name", () => {
  const text = "version: 1\nenvironments:\n  - { name: integ, match: [\"IN*\"] }\nrules:\n  - { classes: [read], decision: allow }\n  - { env: intgr, decision: allow }\n";
  assert.throws(() => parsePolicy(text, "team.yaml"), /team\.yaml: rule 2: env intgr is not defined/);
});

test("policy refs: undefined role, partition and class; reserved and duplicate names", () => {
  const bad = (body: string, re: RegExp) => assert.throws(() => parsePolicy("version: 1\n" + PARTS + body, "p.yaml"), re);
  bad("rules:\n  - { roles: [dve], decision: allow }\n", /rule 1: role dve is not defined/);
  bad("rules:\n  - { partition: prd, decision: allow }\n", /rule 1: partition prd is not defined/);
  bad("rules:\n  - { classes: [promote_qa], decision: allow }\n", /rule 1: class promote_qa is not defined/);
  bad("rules:\n  - { classes: [unqualified], decision: allow }\n", /rule 1: class unqualified can never be matched/);
  bad("mode: { default: observe, prd: enforce }\nrules: []\n", /mode: partition prd is not defined/);
  bad("default_role: nobody\nrules: []\n", /default_role: role nobody is not defined/);
  bad("environments:\n  - { name: x, libraries: [X], partitions: [prd] }\nrules: []\n", /environment x: partition prd is not defined/);
  bad("environments:\n  - { name: unmatched, libraries: [X] }\nrules: []\n", /environment unmatched is reserved/);
  bad("roles:\n  - { name: any, users: [X] }\nrules: []\n", /role "any" is reserved/);
  bad("roles:\n  - { name: dev, users: [X] }\n  - { name: dev, users: [Y] }\nrules: []\n", /role dev is defined twice/);
  bad("commands:\n  PRMOBJ: { class: promote, params: { TOLIB: { kind: library, partition: prd } } }\nrules: []\n", /command PRMOBJ: partition prd is not defined/);
  assert.throws(() => parsePolicy("version: 1\npartitions:\n  - { name: dev, rdbs: [A] }\n  - { name: qa, rdbs: [A] }\nunknown_partition: qa\nrules: []\n", "p.yaml"), /RDB A is listed by partitions dev and qa/);
  assert.throws(() => parsePolicy("version: 1\npartitions:\n  - { name: dev, rdbs: [A] }\nrules: []\n", "p.yaml"), /unknown_partition is required/);
});

test("policy refs: reserved environments and custom classes from a command table are usable", () => {
  const p = parsePolicy(
    "version: 1\ncommands:\n  CMPRM: { class_by_param: { param: LEVEL, values: { QA: promote_qa }, default: danger } }\nrules:\n  - { env: [unmatched, unqualified], classes: [read], decision: allow }\n  - { classes: promote_qa, decision: confirm }\n",
    "p.yaml",
  );
  assert.deepEqual(p.warnings, []);
});

test("policy shadows: Q* before QT* on the same partitions warns naming both", () => {
  const p = parsePolicy("version: 1\nenvironments:\n  - { name: system, match: [\"Q*\"] }\n  - { name: test, match: [\"QT*\"] }\nrules: []\n", "p.yaml");
  assert.deepEqual(p.warnings, ["p.yaml: environment test can never match: environment system comes first and covers it"]);
});

test("policy shadows: QT* on one partition before Q* everywhere does not warn", () => {
  const p = parsePolicy("version: 1\n" + PARTS + "environments:\n  - { name: test, match: [\"QT*\"], partitions: [qa] }\n  - { name: system, match: [\"Q*\"] }\nrules: []\n", "p.yaml");
  assert.deepEqual(p.warnings, []);
});

test("policy shadows: an exact name an earlier entry covers warns", () => {
  const p = parsePolicy("version: 1\nenvironments:\n  - { name: live, match: [\"LV*\"] }\n  - { name: blocked, libraries: [PAYLIB, LVPAY] }\nrules: []\n", "p.yaml");
  assert.deepEqual(p.warnings, ["p.yaml: environment blocked: LVPAY can never match: environment live comes first and covers it"]);
});

test("policy shadows: a rule after a catch-all warns", () => {
  const p = parsePolicy("version: 1\nroles:\n  - { name: dev, groups: [GRPDEV] }\nrules:\n  - { classes: [read], decision: allow }\n  - { roles: any, decision: deny }\n  - { roles: [dev], classes: [read], decision: deny }\n  - { classes: [write], decision: allow }\n", "p.yaml");
  assert.deepEqual(p.warnings, [
    "p.yaml: rule 3 can never match: rule 1 comes first and matches everything it does",
    "p.yaml: rule 4 can never match: rule 2 comes first and matches everything it does",
  ]);
});

test("policy shadows: the D4 example and the built-in policy load without warnings", () => {
  assert.deepEqual(loadPolicy(EXAMPLE).warnings, []);
  assert.deepEqual(builtinPolicy().warnings, []);
});

// --- environments, partitions and roles (task 2.3) ---

const D4 = loadPolicy(EXAMPLE);

test("Shared entry: PAYLIB is blocked on every partition", () => {
  for (const part of ["dev", "qa", "prod"]) assert.equal(environmentOf("PAYLIB", part, "JDOE", D4), "blocked");
});

test("Order decides overlap: on qa QTORD is test and QSYS2 is system; elsewhere QTORD is system", () => {
  assert.equal(environmentOf("QTORD", "qa", "JDOE", D4), "test");
  assert.equal(environmentOf("QSYS2", "qa", "JDOE", D4), "system");
  assert.equal(environmentOf("QTORD", "dev", "JDOE", D4), "system");
  assert.equal(environmentOf("QTORD", "prod", "JDOE", D4), "system");
});

test("Personal library: JDOE is personal for JDOE and JDOEX is not", () => {
  assert.equal(environmentOf("JDOE", "dev", "JDOE", D4), "personal");
  assert.equal(environmentOf("JDOE_T1", "dev", "jdoe", D4), "personal");
  assert.equal(environmentOf("JDOEX", "dev", "JDOE", D4), "unmatched");
  assert.equal(environmentOf("JDOE", "dev", "ASMITH", D4), "unmatched");
  assert.equal(environmentOf("JDOE", "qa", "JDOE", D4), "unmatched", "personal is limited to dev");
});

test("environments: case, system names only, $ and # in names, partition filter, no partition", () => {
  assert.equal(environmentOf("qtemp", "dev", "JDOE", D4), "scratch");
  assert.equal(environmentOf("ORDER_HISTORY", "dev", "JDOE", D4), "unmatched", "a long schema name never matches");
  assert.equal(environmentOf("DVORD", "dev", "JDOE", D4), "devlibs");
  assert.equal(environmentOf("DVORD", "qa", "JDOE", D4), "unmatched");
  assert.equal(environmentOf("DVORD", undefined, "JDOE", D4), "unmatched", "a partition-limited entry needs a partition");
  assert.equal(environmentOf("LVORD", undefined, "JDOE", D4), "live");
  const p = parsePolicy("version: 1\nenvironments:\n  - { name: personal, match: [\"${USER}\"] }\n  - { name: hash, match: [\"A#*\"] }\nrules: []\n", "p.yaml");
  assert.equal(environmentOf("J$DOE", undefined, "J$DOE", p), "personal");
  assert.equal(environmentOf("JXDOE", undefined, "J$DOE", p), "unmatched", "$ in a user name is literal");
  assert.equal(environmentOf("A#1", undefined, "JDOE", p), "hash");
});

test("Profile named after the wrong box: the RDB decides", () => {
  assert.deepEqual(detectPartition(D4, { rdb: "PRODRDB" }), { partition: "prod" });
});

test("IASP database name: QAIASP1 is qa", () => {
  assert.deepEqual(detectPartition(D4, { rdb: "qaiasp1" }), { partition: "qa" });
});

test("Names disagree: System dev and RDB qa is a conflict naming both", () => {
  const r = detectPartition(D4, { system: "DEVBOX", rdb: "QARDB" });
  assert.equal(r.partition, undefined);
  assert.match(r.conflict ?? "", /dev and qa/);
});

test("partitions: agreement, a declaration, an unknown box", () => {
  assert.deepEqual(detectPartition(D4, { system: "QABOX", rdb: "QAIASP1", declared: "qa" }), { partition: "qa" });
  assert.match(detectPartition(D4, { rdb: "PRODRDB", declared: "dev" }).conflict ?? "", /dev and prod|prod and dev/);
  assert.match(detectPartition(D4, { declared: "test" }).conflict ?? "", /IBMI_PARTITION test is not a partition/);
  assert.deepEqual(detectPartition(D4, { system: "OTHERBOX", rdb: "OTHERRDB" }), { partition: "prod" }, "unknown_partition");
  assert.deepEqual(detectPartition(D4, { system: "OTHERBOX", rdb: "QARDB" }), { partition: "qa" }, "an unmapped name does not disagree");
  assert.deepEqual(detectPartition(builtinPolicy(), { rdb: "ANY" }), {}, "no partitions: none");
});

test("Dev and QA: a user in both groups holds both roles", () => {
  assert.deepEqual(rolesOf({ user: "JDOE", groups: ["GRPDEV", "grpqa"], authlists: [] }, D4).roles.sort(), ["dev", "qa"]);
});

test("Per-user exception: users: [JDOE] gives JDOE the role", () => {
  const p = parsePolicy("version: 1\nroles:\n  - { name: dev, groups: [GRPDEV], users: [JDOE] }\n  - { name: analyst, groups: [GRPANL] }\ndefault_role: analyst\nrules: []\n", "p.yaml");
  assert.deepEqual(rolesOf({ user: "JDOE", groups: [], authlists: [] }, p).roles, ["dev"]);
  assert.deepEqual(rolesOf({ user: "ASMITH", groups: [], authlists: [] }, p).roles, ["analyst"]);
});

test("Lookup not permitted: default_role; user patterns still match", () => {
  assert.deepEqual(rolesOf({ user: "JDOE" }, D4), { roles: ["analyst"], source: "default_lookup_failed" });
  assert.deepEqual(rolesOf({ user: "JDOE", groups: ["OTHER"] }, D4).source, "default_lookup_failed", "authorization lists unknown");
  assert.deepEqual(rolesOf({ user: "JDOE", groups: [], authlists: [] }, D4), { roles: ["analyst"], source: "default_no_match" });
  assert.deepEqual(rolesOf({ user: "JDOE", groups: ["GRPDEV"], authlists: [] }, D4), { roles: ["dev"], source: "matched" });
  const r = decide([{ class: "read", source: "sql", object: { lib: "A", name: "T" } }], { user: "JDOE", partition: "dev" }, D4);
  assert.deepEqual([r.roles, r.roleSource], [["analyst"], "default_lookup_failed"], "decide reports the roles and why");
  assert.deepEqual(rolesOf({ user: "CTR01" }, D4).roles, ["contractor"], "a contractor stays a contractor");
});

test("roles: authorization lists and supplemental groups", () => {
  assert.deepEqual(rolesOf({ user: "JDOE", groups: [], authlists: ["AUTLQA"] }, D4).roles, ["qa"]);
  assert.deepEqual(rolesOf({ user: "JDOE", groups: ["GRPANL", "GRPDEV"] }, D4).roles.sort(), ["analyst", "dev"]);
  assert.deepEqual(rolesOf({ user: "JDOE", groups: [] }, builtinPolicy()).roles, [], "no roles and no default");
});

// --- decide (execution-policy spec; task 2.4) ---

const WHO: Record<string, Identity> = {
  dev: { user: "JDOE", groups: ["GRPDEV"], authlists: [] },
  qa: { user: "JDOE", groups: ["GRPQA"], authlists: [] },
  "dev+qa": { user: "JDOE", groups: ["GRPDEV", "GRPQA"], authlists: [] },
  contractor: { user: "CTR01", groups: [], authlists: [] },
  analyst: { user: "ANL01", groups: ["GRPANL"], authlists: [] },
};
const as = (who: string, partition: string): Identity => ({ ...WHO[who], partition });
const d4ctx = (stub: Stub = {}): ClassifyContext => ({ lookups: lookups(stub), commands: D4.commands, rdbs: D4.rdbs });
async function decideScript(script: string, who: Identity, stub: Stub = {}) {
  const c = await classify(script, d4ctx(stub));
  return decide(c.operations, who, D4);
}

// The D4 example as a decision table. Libraries stand for environments: ME is the user's own
// library, ~ an unqualified read or call, - an operation on no object. Every cell not listed as
// allowed is expected to be denied. Written by hand from the rules, not computed.
const LIBS = ["QTEMP", "ME", "PAYLIB", "QTORD", "QSYS2", "DVORD", "INORD", "SQORD", "SPORD", "LVORD", "XYZLIB", "~", "-"];
const CLASSES = ["read", "write", "ddl", "compile", "call", "liblist", "promote", "promote_qa", "promote_prod"];
const NOT_PAY = "QTEMP ME QTORD QSYS2 DVORD INORD SQORD SPORD LVORD XYZLIB";
const BASE = [`read|${NOT_PAY} ~ -`, "write ddl|QTEMP"]; // rule 3 (scratch) and rule 10 (read)
const LIBLIST = `liblist|${NOT_PAY} -`; // rule 9
const OWN = `${CLASSES.join(" ")}|ME DVORD INORD`; // rule 6: personal, devlibs, integ on dev
const QA_DEV = [...BASE, LIBLIST, OWN, `promote_qa|${NOT_PAY} -`]; // + rule 7
const QA_QA = [...BASE, LIBLIST, "read write call|QTORD"]; // + rule 8
const ALLOWED: Record<string, Record<string, string[]>> = {
  analyst: { dev: BASE, qa: BASE, prod: BASE },
  contractor: { dev: ["read|QTEMP ME DVORD INORD", "write ddl|QTEMP"], qa: ["read write ddl|QTEMP"], prod: ["read write ddl|QTEMP"] },
  dev: { dev: [...BASE, LIBLIST, OWN], qa: [...BASE, LIBLIST], prod: [...BASE, LIBLIST] },
  qa: { dev: QA_DEV, qa: QA_QA, prod: [...BASE, LIBLIST] },
  "dev+qa": { dev: QA_DEV, qa: QA_QA, prod: [...BASE, LIBLIST] },
};

function cellOp(cls: string, lib: string, user: string): Operation | undefined {
  if (lib === "-") return { class: cls, source: "cl", command: "XCMD" };
  if (lib === "~") return cls === "read" || cls === "call" ? { class: cls, source: "sql", object: { name: "T" }, env: "unqualified" } : undefined;
  const l = lib === "ME" ? user : lib;
  return { class: cls, source: "sql", object: cls === "liblist" ? { lib: l, name: l, type: "*LIB" } : { lib: l, name: "T" } };
}

test("decide: the D4 example as a decision table (roles x partitions x environments x classes)", () => {
  const wrong: string[] = [];
  let cells = 0;
  for (const [who, byPart] of Object.entries(ALLOWED))
    for (const [part, allowed] of Object.entries(byPart)) {
      const yes = new Set(
        allowed.flatMap((spec) => {
          const [cs, ls] = spec.split("|");
          return cs.split(" ").flatMap((c) => ls.split(" ").map((l) => `${c}@${l}`));
        }),
      );
      for (const cls of CLASSES)
        for (const lib of LIBS) {
          const op = cellOp(cls, lib, WHO[who].user);
          if (!op) continue;
          cells++;
          const got = decide([op], as(who, part), D4).decision;
          const want = yes.has(`${cls}@${lib}`) ? "allow" : "deny";
          if (got !== want) wrong.push(`${who} on ${part}: ${cls} ${lib} -> ${got}, expected ${want}`);
        }
    }
  assert.deepEqual(wrong, []);
  assert.equal(cells, 5 * 3 * (CLASSES.length * (LIBS.length - 1) + 2));
});

test("decide: environments resolve per partition inside decide", () => {
  const env = (lib: string, part: string) => decide([cellOp("read", lib, "JDOE")!], as("dev", part), D4).operations[0].env;
  assert.equal(env("QTORD", "dev"), "system");
  assert.equal(env("QTORD", "qa"), "test");
  assert.equal(env("DVORD", "qa"), "unmatched");
  assert.equal(env("ME", "dev"), "personal");
  assert.equal(env("~", "dev"), "unqualified");
});

test("Default deny: a ddl on qa no rule matches is denied naming the operation", () => {
  const r = decide([{ class: "ddl", source: "sql", object: { lib: "QSYS2", name: "T" } }], as("dev", "qa"), D4);
  assert.equal(r.decision, "deny");
  assert.equal(r.operations[0].reason, "no_rule");
  assert.match(r.operations[0].message, /no rule matches ddl QSYS2\.T \(environment system, partition qa\)/);
});

test("Read live, write own library: INSERT INTO JDOE.T SELECT * FROM LVORD.X is allowed, with each operation's rule", async () => {
  const r = await decideScript("INSERT INTO JDOE.T SELECT * FROM LVORD.X", as("dev", "dev"));
  assert.equal(r.decision, "allow");
  const by = Object.fromEntries(r.operations.map((o) => [`${o.operation.class} ${o.operation.object?.lib}`, [o.reason, o.rule, o.env]]));
  assert.deepEqual(by, { "write JDOE": ["rule", 6, "personal"], "read LVORD": ["rule", 10, "live"] });
});

test("One denied part denies the statement: a QTEMP alias to live", async () => {
  const script = "CREATE ALIAS QTEMP.A FOR LVORD.ORD;\nDELETE FROM QTEMP.A";
  const c = await classify(script, d4ctx({ bases: { "QTEMP.A": [{ lib: "LVORD", name: "ORD" }] } }));
  const del = decide(c.statements[1].operations, as("dev", "prod"), D4);
  assert.deepEqual(del.operations.map((o) => [o.operation.object?.lib, o.decision]), [["QTEMP", "allow"], ["LVORD", "deny"]]);
  assert.deepEqual([del.decision, del.effective], ["deny", "deny"]);
});

test("decide: task rows (integ, stage_qa, promote_qa, contractor)", async () => {
  assert.equal((await decideScript("DELETE FROM INORD.T", as("dev", "dev"))).decision, "allow");
  assert.equal((await decideScript("DELETE FROM SQORD.T", as("dev", "dev"))).decision, "deny");
  const promote = await decideScript("CL: CMPRM REQ(1234) LEVEL(QA)", as("qa", "dev"));
  assert.deepEqual([promote.decision, promote.operations[0].rule, promote.operations[0].env], ["allow", 7, undefined]);
  assert.equal((await decideScript("CL: CMPRM REQ(1234) LEVEL(QA)", as("dev", "dev"))).decision, "deny");
  assert.equal((await decideScript("CL: CMPRM REQ(1234) LEVEL(HOTFIX)", as("qa", "dev"))).operations[0].reason, "danger");
  const ctr = await decideScript("UPDATE DVORD.T SET C = 1", as("contractor", "dev"));
  assert.deepEqual([ctr.decision, ctr.operations[0].rule], ["deny", 5]);
});

test("Observe a would-be deny: logged deny, not enforced, runs", async () => {
  const r = await decideScript("DELETE FROM SQORD.T", as("dev", "dev"));
  assert.deepEqual([r.decision, r.enforced, r.effective, r.operations[0].enforced], ["deny", false, "allow", false]);
});

test("Danger still blocked while observing: PWRDWNSYS", async () => {
  const r = await decideScript("CL: PWRDWNSYS OPTION(*IMMED)", as("dev", "dev"));
  assert.deepEqual([r.decision, r.enforced, r.effective, r.operations[0].reason], ["deny", true, "deny", "danger"]);
});

test("Unqualified still blocked while observing", async () => {
  const r = await decideScript("UPDATE T SET C = 1", as("dev", "dev"));
  assert.deepEqual([r.effective, r.operations[0].reason], ["deny", "unqualified"]);
});

test("Unknown command observed: FROBCMD X runs, logged deny / enforced false / unknown_command", async () => {
  const r = await decideScript("CL: FROBCMD X", as("dev", "dev"));
  assert.deepEqual([r.decision, r.enforced, r.effective, r.operations[0].reason], ["deny", false, "allow", "unknown_command"]);
});

test("Unknown command enforced: FROBCMD X on an enforcing partition is denied", async () => {
  const r = await decideScript("CL: FROBCMD X", as("dev", "prod"));
  assert.deepEqual([r.effective, r.operations[0].reason], ["deny", "unknown_command"]);
});

test("Qualified unknown command still blocked while observing: MYLIB/FROBCMD X", async () => {
  const r = await decideScript("CL: MYLIB/FROBCMD X", as("dev", "dev"));
  assert.deepEqual([r.effective, r.operations[0].reason], ["deny", "danger"]);
});

test("Unknown command next to a danger command: the operations together are denied", async () => {
  const c = await classify("CL: FROBCMD X\nCL: PWRDWNSYS OPTION(*IMMED)", d4ctx());
  assert.equal(decide(c.operations, as("dev", "dev"), D4).effective, "deny");
  assert.equal(decide(c.statements[0].operations, as("dev", "dev"), D4).effective, "allow", "alone it would run");
  assert.equal(decide(c.statements[1].operations, as("dev", "dev"), D4).effective, "deny");
});

test("One partition enforced: a denied write is blocked on prod and only logged on dev", async () => {
  const prod = await decideScript("DELETE FROM LVORD.T", as("dev", "prod"));
  const dev = await decideScript("DELETE FROM LVORD.T", as("dev", "dev"));
  assert.deepEqual([prod.decision, prod.effective], ["deny", "deny"]);
  assert.deepEqual([dev.decision, dev.effective], ["deny", "allow"]);
});

test("decide: an operation's own partition sets its environments, rules and mode", () => {
  // run on dev (observe), writing through a mapped RDB on prod (enforce)
  const op: Operation = { class: "write", source: "sql", object: { rdb: "PRODRDB", lib: "DVORD", name: "T" }, partition: "prod" };
  const r = decide([op], as("dev", "dev"), D4);
  assert.deepEqual([r.operations[0].partition, r.operations[0].env, r.effective], ["prod", "unmatched", "deny"]);
});

test("decide: a partition conflict denies everything, even while observing and with no operations", async () => {
  const who: Identity = { ...WHO.dev, conflict: "System DEVBOX, RDB QARDB map to different partitions: dev and qa" };
  const r = await decideScript("SELECT * FROM QTEMP.T", who);
  assert.deepEqual([r.effective, r.operations[0].reason], ["deny", "partition_conflict"]);
  assert.match(r.operations[0].message, /dev and qa/);
  assert.deepEqual(decide([], who, D4), { decision: "deny", effective: "deny", enforced: true, operations: [], roles: ["dev"], roleSource: "matched", reason: "partition_conflict" });
});

// Decision: a statement with no operations (COMMIT, VALUES 1) is allowed with reason
// no_operations in every mode. The classifier only returns no operations for statements it read
// completely and found harmless; anything it cannot read is danger, so this is not default deny.
test("decide: zero-operation statements are allowed, not default-denied", async () => {
  const c = await classify("COMMIT; VALUES 1", d4ctx());
  assert.equal(c.statements.length, 2);
  for (const s of c.statements) {
    assert.deepEqual(s.operations, []);
    for (const part of ["dev", "prod"])
      for (const who of ["contractor", "analyst"])
        assert.deepEqual(decide(s.operations, as(who, part), D4), { decision: "allow", effective: "allow", enforced: false, operations: [], roles: [who], roleSource: "matched", reason: "no_operations" });
  }
});

// Decision: an operation on no object (WRKACTJOB) has no environment; only rules whose env is
// omitted or `any` match it, so an `env:` rule (even env: unmatched) can never catch it.
test("decide: object-less CL is matched by rules without env only", async () => {
  const dev = await decideScript("CL: WRKACTJOB", as("dev", "prod"));
  assert.deepEqual([dev.decision, dev.operations[0].rule, dev.operations[0].env], ["allow", 10, undefined]);
  const ctr = await decideScript("CL: WRKACTJOB", as("contractor", "dev"));
  assert.deepEqual([ctr.decision, ctr.operations[0].rule], ["deny", 5]);
  const p = parsePolicy("version: 1\nrules:\n  - { env: unmatched, decision: deny }\n  - { env: any, classes: [read], decision: confirm }\n", "p.yaml");
  const r = decide((await classify("CL: WRKACTJOB", { lookups: lookups() })).operations, { user: "JDOE" }, p);
  assert.deepEqual([r.decision, r.operations[0].rule], ["confirm", 2]);
});

test("decide: confirm is asked in enforce mode and runs unasked while observing", () => {
  const text = (mode: string) => `version: 1\nmode: ${mode}\nrules:\n  - { classes: [write], decision: confirm }\n  - { decision: allow }\n`;
  const ops: Operation[] = [
    { class: "write", source: "sql", object: { lib: "A", name: "T" } },
    { class: "read", source: "sql", object: { lib: "B", name: "T" } },
  ];
  const enforce = decide(ops, { user: "JDOE" }, parsePolicy(text("enforce"), "p.yaml"));
  assert.deepEqual([enforce.decision, enforce.effective, enforce.enforced], ["confirm", "confirm", true]);
  assert.match(enforce.operations[0].message, /rule 1 asks to confirm write A\.T/);
  const observe = decide(ops, { user: "JDOE" }, parsePolicy(text("observe"), "p.yaml"));
  assert.deepEqual([observe.decision, observe.effective, observe.enforced], ["confirm", "allow", false]);
});

test("decide: the built-in policy allows and logs, denying only danger and unqualified", async () => {
  const p = builtinPolicy();
  const run = async (s: string) => decide((await classify(s, { lookups: lookups() })).operations, { user: "JDOE" }, p);
  const del = await run("DELETE FROM LVORD.T");
  assert.deepEqual([del.effective, del.operations[0].rule], ["allow", 1]);
  assert.equal((await run("CL: SBMJOB CMD(DLTLIB X)")).effective, "deny");
  assert.equal((await run("DELETE FROM T")).effective, "deny");
  const frob = await run("CL: FROBCMD X");
  assert.deepEqual([frob.decision, frob.effective], ["deny", "allow"]);
});

test("decide: an identity without a partition is decided on unknown_partition", async () => {
  const r = await decideScript("DELETE FROM LVORD.T", { user: "JDOE", groups: ["GRPDEV"] });
  assert.deepEqual([r.operations[0].partition, r.effective], ["prod", "deny"]);
});

test("decide: a literal command through QCMDEXC that is not in the table is unknown_command", async () => {
  const r = await decideScript("CALL QSYS2.QCMDEXC('FROBCMD X')", as("dev", "dev"));
  assert.deepEqual([r.operations[0].reason, r.effective], ["unknown_command", "allow"]);
});

// --- review fixes ---

test("review: command-carrying and system-changing commands are danger even while observing", async () => {
  const p = builtinPolicy();
  for (const script of [
    "CL: ADDJOBSCDE JOB(X) CMD(PWRDWNSYS OPTION(*IMMED)) FRQ(*ONCE)",
    "CL: CHGJOBD JOBD(QGPL/QDFTJOBD) RQSDTA('PWRDWNSYS')",
    "CL: CHGCMDDFT CMD(DSPLIB) NEWDFT('X')",
    "CL: RMVLNK OBJLNK('/home')",
    "CALL QSYS2.QCMDEXC('ADDJOBSCDE JOB(X) CMD(DSPLIB) FRQ(*ONCE)')",
    "CL: FROBJOB CMD(PWRDWNSYS)",
    "CL: FROBJOB RQSDTA('PWRDWNSYS')",
  ]) {
    const c = await classify(script, { lookups: lookups() });
    const r = decide(c.operations, { user: "JDOE" }, p);
    assert.deepEqual([r.effective, r.operations[0].reason, c.operations[0].code], ["deny", "danger", undefined], script);
  }
  const t = builtinCommands();
  for (const cmd of ["ADDJOBSCDE", "CHGJOBSCDE", "ADDAJE", "CHGAJE", "CHGJOBD", "SBMDBJOB", "STRS36PRC", "TFRCTL", "CHGCMDDFT", "CHGCMD", "ADDEXITPGM", "RMVLNK", "DEL", "RMVDIR", "RNM", "MOV", "CHGAUT", "CHGOWN", "DLTJRNRCV", "CHGOBJAUD", "DLTAUTL", "CHGAUTLE"])
    assert.equal(t[cmd]?.class, "danger", cmd);
});

test("review: a partition named after an Object property does not change the mode", () => {
  for (const name of ["toString", "constructor"]) {
    const p = parsePolicy(`version: 1\nmode: enforce\npartitions:\n  - { name: ${name}, rdbs: [T] }\nunknown_partition: ${name}\nrules: []\n`, "p.yaml");
    const r = decide([{ class: "write", source: "sql", object: { lib: "A", name: "T" } }], { user: "JDOE", partition: name }, p);
    assert.deepEqual([r.decision, r.effective], ["deny", "deny"], name);
  }
});

test("review: IBMI_PARTITION is ignored when the policy lists no partitions", async () => {
  const p = builtinPolicy();
  const who = detectPartition(p, { declared: "dev" });
  assert.deepEqual(who, {});
  const r = decide((await classify("DELETE FROM LVORD.T", { lookups: lookups() })).operations, { user: "JDOE", ...who }, p);
  assert.equal(r.effective, "allow");
});

test("review: a command-table partition is enforced if either it or the connection enforces; a remote RDB takes its own", () => {
  // connection prod (enforce), target dev (observe) through a parameter's partition:
  const param: Operation = { class: "promote", source: "cl", command: "PRMOBJ", object: { lib: "DVORD", name: "DVORD", type: "*LIB" }, partition: "dev" };
  const r1 = decide([param], as("analyst", "prod"), D4);
  assert.deepEqual([r1.operations[0].partition, r1.decision, r1.effective], ["dev", "deny", "deny"]);
  // the same through a mapped RDB runs on dev, so only dev's (observe) mode applies
  const remote: Operation = { class: "write", source: "sql", object: { rdb: "DEVRDB", lib: "LVORD", name: "T" }, partition: "dev" };
  const r2 = decide([remote], as("dev", "prod"), D4);
  assert.deepEqual([r2.decision, r2.effective], ["deny", "allow"]);
  // connection dev (observe), target prod (enforce): enforced either way
  assert.equal(decide([{ ...param, partition: "prod" }], as("analyst", "dev"), D4).effective, "deny");
});

test("review: command_files stay inside the policy's folder; overriding a shipped danger warns", () => {
  const dir = tmp();
  writeFileSync(join(dir, "ok.yaml"), "commands:\n  SBMJOB: { class: call }\n");
  const policy = join(dir, "policy.yaml");
  for (const f of [join(dir, "ok.yaml"), "../ok.yaml", "sub/../../ok.yaml"]) {
    writeFileSync(policy, `version: 1\ncommand_files: ["${f.replace(/\\/g, "/")}"]\nrules: []\n`);
    assert.throws(() => loadPolicy(policy), /must be a relative path inside the policy's folder/, f);
  }
  writeFileSync(policy, "version: 1\ncommand_files: [ok.yaml]\nrules: []\n");
  assert.deepEqual(loadPolicy(policy).warnings, [`${policy}: ok.yaml overrides SBMJOB, which the shipped table classes danger`]);
});

test("review 2: program-running commands, carrier keywords and outage commands are danger while observing", async () => {
  const p = builtinPolicy();
  for (const script of ["CL: SBMNWSCMD 'format d:' NWS1", "CL: FROBX PGM(EVIL/P)", "CL: FROBX TRGPGM(EVIL/P)", "CL: FROBX CLASS(EVIL/C)", "CL: FROBX CMD (PWRDWNSYS)", "CL: VRYCFG CFGOBJ(L1) CFGTYPE(*LIN) STATUS(*OFF)"]) {
    const c = await classify(script, { lookups: lookups() });
    const r = decide(c.operations, { user: "JDOE" }, p);
    assert.deepEqual([r.effective, r.operations[0].reason], ["deny", "danger"], script);
  }
  const frob = await classify("CL: FROBCMD X (Y)", { lookups: lookups() });
  assert.equal(frob.operations[0].code, "unknown_command", "positional values never carry");
  const t = builtinCommands();
  for (const cmd of ["SBMNWSCMD", "ADDPFTRG", "CHGPFTRG", "ADDRTGE", "CHGRTGE", "ADDPJE", "CHGPJE", "JAVA", "RUNJVA", "VRYCFG", "ENDTCPSVR", "ENDHOSTSVR", "ENDPJ", "ENDTCPIFC", "ENDWTR", "CLRJOBQ", "CLROUTQ", "DLTSPLF", "DLTJRN", "CHGJRN", "RSTUSRPRF", "RSTAUT", "CHGIPLA", "ADDRPYLE"])
    assert.equal(t[cmd]?.class, "danger", cmd);
});

// --- verbs: openspec/changes/project-verbs/specs/verbs/spec.md ---

// A temp root with home/, repo/ and policy/, and `files` (paths from the root) written in.
function verbRoot(files: Record<string, string>, extra?: string[]): { root: string; src: VerbSources } {
  const root = mkdtempSync(join(tmpdir(), "guard-verbs-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  const src: VerbSources = { home: join(root, "home"), cwd: join(root, "repo"), policyFile: join(root, "policy", "policy.yaml") };
  if (extra) src.extra = extra.map((d) => join(root, d)).join(delimiter);
  return { root, src };
}
const U = "home/.ibmi-agent-kit/verbs/";
const P = "repo/.ibmi-kit/verbs/";
const O = "policy/verbs/";
const verbYaml = (name: string, steps = "  - sql: VALUES 1") => `name: ${name}\ndescription: test verb\nsteps:\n${steps}\n`;
const calls = (name: string, callee: string) => verbYaml(name, `  - verb: ${callee}`);
const addresses = (set: { verbs: { address: string }[] }) => set.verbs.map((v) => v.address);

test("verbs: unknown key is refused naming the file and key; other verbs still load", () => {
  const { root, src } = verbRoot({ [P + "BAD.yaml"]: "name: BAD\ndescription: d\nstep:\n  - sql: VALUES 1\n", [P + "GOOD.yaml"]: verbYaml("GOOD") });
  const set = loadVerbs(src);
  assert.deepEqual(addresses(set), ["proj:GOOD"]);
  assert.equal(set.errors.length, 1);
  assert.ok(set.errors[0].split("\n").includes(`${join(root, P, "BAD.yaml")}: (top): Unrecognized key: "step"`), set.errors[0]);
});

const SAMPLE = fileURLToPath(new URL("../../../examples/verbs/SMOKE-SAMPLE.yaml", import.meta.url));

test("verbs: examples/verbs/SMOKE-SAMPLE.yaml loads through the real loader", () => {
  const set = loadVerbs({ cwd: join(dirname(SAMPLE), "nowhere"), extra: dirname(SAMPLE) });
  assert.deepEqual(set.errors, []);
  assert.deepEqual(addresses(set), ["proj:SMOKE-SAMPLE"]);
});

test("verbs: the guard README embeds SMOKE-SAMPLE.yaml byte for byte", () => {
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  const readme = lf(readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8"));
  const block = /```yaml\n(name: SMOKE-SAMPLE\n[\s\S]*?)```/.exec(readme);
  assert.ok(block, "README has the SMOKE-SAMPLE yaml block");
  assert.equal(block[1], lf(readFileSync(SAMPLE, "utf8")));
});

test("verbs: project folder found automatically; user, IBMI_KIT_VERBS and org layers load", () => {
  const files = { [P + "SMOKE-ORDERS.yaml"]: verbYaml("SMOKE-ORDERS"), [U + "MINE.yml"]: verbYaml("mine"), "x1/A.yaml": verbYaml("X1"), "x2/B.yaml": verbYaml("X2"), [O + "TEAM.yaml"]: verbYaml("TEAM"), [P + "notes.txt"]: "not a verb" };
  const set = loadVerbs(verbRoot(files, ["x1", "x2"]).src);
  assert.deepEqual(set.errors, []);
  assert.deepEqual(addresses(set), ["org:TEAM", "proj:SMOKE-ORDERS", "proj:X1", "proj:X2", "user:MINE"]);
});

test("verbs: missing folders load nothing; a missing IBMI_KIT_VERBS folder is an error", () => {
  const { root, src } = verbRoot({ [O + "TEAM.yaml"]: verbYaml("TEAM") });
  assert.deepEqual(loadVerbs({ home: src.home, cwd: src.cwd }), { verbs: [], refused: [], errors: [] });
  assert.deepEqual(loadVerbs({ ...src, extra: join(root, "nope") }).errors, [`IBMI_KIT_VERBS: ${join(root, "nope")} not found`]);
});

test("verbs: personal override: the closest layer wins a bare name and the hidden verb is marked", () => {
  const set = loadVerbs(verbRoot({ [U + "r.yaml"]: verbYaml("RESET-DATA"), [O + "r.yaml"]: verbYaml("reset-data"), [O + "only.yaml"]: verbYaml("ONLY") }).src);
  assert.equal(resolveVerb(set, "RESET-DATA").address, "user:RESET-DATA");
  assert.equal(resolveVerb(set, "reset-data").address, "user:RESET-DATA");
  assert.equal(resolveVerb(set, "org:RESET-DATA").address, "org:RESET-DATA");
  assert.equal(resolveVerb(set, "ONLY").address, "org:ONLY");
  assert.deepEqual(set.verbs.map((v) => [v.address, v.overridden]), [["org:ONLY", false], ["org:RESET-DATA", true], ["user:RESET-DATA", false]]);
  assert.throws(() => resolveVerb(set, "NONE"), /no verb NONE/);
  assert.throws(() => resolveVerb(set, "qa:RESET-DATA"), /not a verb address/);
});

test("verbs: a refused closer verb stops a bare name instead of falling through", () => {
  const set = loadVerbs(verbRoot({ [U + "r.yaml"]: verbYaml("RESET-DATA", "  - sql: VALUES :nope"), [O + "r.yaml"]: verbYaml("RESET-DATA") }).src);
  assert.match(set.errors.join("\n"), /steps\.0\.sql: :nope is not a parameter/);
  assert.deepEqual(set.refused, ["user:RESET-DATA"]);
  assert.throws(() => resolveVerb(set, "RESET-DATA"), /user:RESET-DATA was refused at load/);
  assert.equal(resolveVerb(set, "org:RESET-DATA").overridden, true);
  // a schema failure (step: typo) refuses its declared name; a YAML syntax error, the name on its
  // `name:` line, else its file name
  const typo = loadVerbs(verbRoot({ [U + "r.yaml"]: "name: RESET-DATA\ndescription: d\nstep:\n  - sql: VALUES 1\n", [O + "r.yaml"]: verbYaml("RESET-DATA") }).src);
  assert.deepEqual(typo.refused, ["user:RESET-DATA"]);
  assert.throws(() => resolveVerb(typo, "RESET-DATA"), /user:RESET-DATA was refused at load/);
  const syntax = loadVerbs(verbRoot({ [U + "r.yaml"]: "name: 'reset-data' # mine\nsteps: [\n", [O + "r.yaml"]: verbYaml("RESET-DATA") }).src);
  assert.deepEqual(syntax.refused, ["user:RESET-DATA"]);
  assert.match(syntax.errors.join("\n"), /r\.yaml line \d+:/);
  assert.throws(() => resolveVerb(syntax, "RESET-DATA"), /user:RESET-DATA was refused at load/);
  const nameless = loadVerbs(verbRoot({ [U + "reset-data.yaml"]: "steps: [\n", [O + "r.yaml"]: verbYaml("RESET-DATA") }).src);
  assert.deepEqual(nameless.refused, ["user:RESET-DATA"]);
});

test("verbs: one folder in two layers is read once, as the first, and reported", () => {
  const { root, src } = verbRoot({ [U + "m.yaml"]: verbYaml("MINE") });
  const set = loadVerbs({ ...src, extra: join(root, "home", ".ibmi-agent-kit", "verbs") });
  assert.deepEqual(addresses(set), ["user:MINE"]);
  assert.deepEqual(set.errors, [`${join(root, "home", ".ibmi-agent-kit", "verbs")} is already read as the user layer; it is not read again as proj`]);
});

test("verbs: duplicate in one layer: neither loads, and the error names both files", () => {
  const { root, src } = verbRoot({ [P + "a.yaml"]: verbYaml("SMOKE-ORDERS"), "x1/b.yaml": verbYaml("smoke-orders"), [O + "s.yaml"]: verbYaml("SMOKE-ORDERS") }, ["x1"]);
  const set = loadVerbs(src);
  assert.deepEqual(addresses(set), ["org:SMOKE-ORDERS"]);
  assert.deepEqual(set.errors, [`proj:SMOKE-ORDERS is declared by ${join(root, P, "a.yaml")} and ${join(root, "x1", "b.yaml")}; none of them loads`]);
  // IBMI_KIT_VERBS naming the project folder again is not a duplicate
  assert.deepEqual(loadVerbs({ ...src, extra: join(root, P) }).errors, []);
});

test("verbs: cycle: both verbs are refused at load naming the cycle, and so are their callers", () => {
  const set = loadVerbs(verbRoot({ [P + "a.yaml"]: calls("A", "B"), [P + "b.yaml"]: calls("B", "proj:A"), [P + "c.yaml"]: calls("C", "A"), [P + "s.yaml"]: calls("SELF", "SELF"), [P + "ok.yaml"]: verbYaml("OK") }).src);
  assert.deepEqual(addresses(set), ["proj:OK"]);
  const all = set.errors.join("\n");
  assert.match(all, /a\.yaml: proj:A is in a cycle: proj:A → proj:B → proj:A/);
  assert.match(all, /b\.yaml: proj:B is in a cycle: proj:A → proj:B → proj:A/);
  assert.match(all, /c\.yaml: steps\.0\.verb: proj:A was refused at load/);
  assert.match(all, /s\.yaml: proj:SELF is in a cycle: proj:SELF → proj:SELF/);
});

test("verbs: nesting is limited to 5 verbs in a chain, the top one counted", () => {
  const files: Record<string, string> = {};
  for (let i = 1; i <= 6; i++) files[`${P}v${i}.yaml`] = i < 6 ? calls(`V${i}`, `V${i + 1}`) : verbYaml("V6");
  const set = loadVerbs(verbRoot(files).src);
  assert.equal(MAX_VERB_DEPTH, 5);
  assert.deepEqual(addresses(set), ["proj:V2", "proj:V3", "proj:V4", "proj:V5", "proj:V6"]);
  assert.match(set.errors.join("\n"), /v1\.yaml: proj:V1 nests more than 5 verbs deep: proj:V1 → proj:V2 → proj:V3 → proj:V4 → proj:V5 → proj:V6/);
});

test("verbs: a call must reach a verb and give only its parameters, and every one without a default", () => {
  const callee = "name: CALLEE\ndescription: d\nparams:\n  a: { type: integer }\n  b: { type: integer, default: 1 }\nsteps:\n  - sql: VALUES :a + :b\n";
  const set = loadVerbs(
    verbRoot({
      [P + "callee.yaml"]: callee,
      [P + "ok.yaml"]: verbYaml("OK", "  - verb: CALLEE\n    args: { a: 5 }"),
      [P + "missing.yaml"]: calls("MISSING", "NOPE"),
      [P + "extra.yaml"]: verbYaml("EXTRA", "  - verb: CALLEE\n    args: { a: 5, c: 1 }"),
      [P + "short.yaml"]: verbYaml("SHORT", "  - verb: CALLEE\n    args: { b: 2 }"),
      [P + "wrong.yaml"]: verbYaml("WRONG", "  - verb: CALLEE\n    args: { a: abc }"),
    }).src,
  );
  assert.match(set.errors.join("\n"), /wrong\.yaml: steps\.0\.args\.a: "abc" is not an integer/);
  assert.deepEqual(addresses(set), ["proj:CALLEE", "proj:OK"]);
  const all = set.errors.join("\n");
  assert.match(all, /missing\.yaml: steps\.0\.verb: no verb NOPE/);
  assert.match(all, /extra\.yaml: steps\.0\.args\.c: proj:CALLEE has no parameter c/);
  assert.match(all, /short\.yaml: steps\.0: proj:CALLEE needs a/);
});

test("verbs: step shapes: one statement per step, cleanup undoes a setup id, ids are unique", () => {
  const cases: [string, RegExp][] = [
    ["steps: []\n", /steps: Too small: expected array to have >=1 items/],
    ["steps:\n  - { sql: VALUES 1, cl: DSPLIB }\n", /steps\.0: give exactly one of sql, cl, expect, verb/],
    ["steps:\n  - { sql: VALUES 1, args: { a: 1 } }\n", /steps\.0: args go with verb/],
    ["steps:\n  - { sql: VALUES 1, requires_absent: VALUES 1 }\n", /steps\.0: Unrecognized key: "requires_absent"/],
    ["steps:\n  - expect: { sql: VALUES 1, rows: 1, empty: true }\n", /steps\.0\.expect: give exactly one of equals, rows, empty/],
    ["setup:\n  - { id: s, sql: VALUES 1 }\n  - { id: s, sql: VALUES 2 }\nsteps:\n  - sql: VALUES 1\n", /setup\.1\.id: s is used twice/],
    ["steps:\n  - sql: VALUES 1\ncleanup:\n  - { undoes: seed, sql: VALUES 1 }\n", /cleanup\.0\.undoes: no setup step has id seed/],
    ["steps:\n  - sql: VALUES 1\ncleanup:\n  - { sql: VALUES 1 }\n", /cleanup\.0\.undoes: Invalid input: expected string, received undefined/],
  ];
  for (const [body, re] of cases) {
    const set = loadVerbs(verbRoot({ [P + "x.yaml"]: `name: X\ndescription: d\n${body}` }).src);
    assert.deepEqual(set.verbs, [], body);
    assert.match(set.errors.join("\n"), re, body);
  }
});

// The verb in design D1, as written there.
const D1_VERB = `name: SMOKE-ORDERS
description: Order validation still accepts a new order
tags: [smoke]
params:
  env:   { type: string, default: IN1, allowed: [IN1, IN2] }
  order: { type: integer, default: 999001 }
setup:
  - id: seed
    requires_absent: "SELECT 1 FROM ORD\${env}.ORDHDR WHERE OHORD = :order"
    sql: "INSERT INTO ORD\${env}.ORDHDR (OHORD, OHCUS) VALUES (:order, 'TEST01')"
steps:
  - cl: "CALL PGM(ORD\${env}/ORDVAL) PARM('\${order}')"
  - expect:
      sql: "SELECT OHSTS FROM ORD\${env}.ORDHDR WHERE OHORD = :order"
      equals: { OHSTS: V }
cleanup:
  - undoes: seed
    sql: "DELETE FROM ORD\${env}.ORDHDR WHERE OHORD = :order"
`;

test("verbs: the D1 example loads; :p becomes bound markers and ${p} checked text", () => {
  const set = loadVerbs(verbRoot({ [P + "SMOKE-ORDERS.yaml"]: D1_VERB }).src);
  assert.deepEqual(set.errors, []);
  const v = resolveVerb(set, "SMOKE-ORDERS");
  const values = bindArgs(v);
  assert.deepEqual(values, { env: "IN1", order: 999001 });
  assert.deepEqual(substitute(v.setup[0].requires_absent!, "sql", v.params, values), { text: "SELECT 1 FROM ORDIN1.ORDHDR WHERE OHORD = ?", params: [999001] });
  assert.deepEqual(substitute(v.setup[0].sql!, "sql", v.params, values), { text: "INSERT INTO ORDIN1.ORDHDR (OHORD, OHCUS) VALUES (?, 'TEST01')", params: [999001] });
  assert.deepEqual(substitute(v.steps[0].cl!, "cl", v.params, bindArgs(v, { env: "IN2", order: "42" })), { text: "CALL PGM(ORDIN2/ORDVAL) PARM('42')", params: [] });
  assert.deepEqual(substitute("VALUES (:order, :env, :order)", "sql", v.params, values), { text: "VALUES (?, ?, ?)", params: [999001, "IN1", 999001] });
});

test("verbs: string parameter in text: ${env} with no allowed list is refused at load, naming the parameter", () => {
  const set = loadVerbs(verbRoot({ [P + "x.yaml"]: "name: X\ndescription: d\nparams:\n  env: { type: string }\nsteps:\n  - sql: SELECT * FROM ORD${env}.ORDHDR\n" }).src);
  assert.deepEqual(set.verbs, []);
  assert.match(set.errors[0], /steps\.0\.sql: \$\{env\}: parameter env is a string with no allowed list, so it would be free text; use :env/);
  assert.throws(() => substitute("SELECT * FROM ORD${env}.ORDHDR", "sql", { env: { type: "string" } }, { env: "X.T; DROP TABLE Y" }), /no allowed list/);
});

test("verbs: value outside allowed: the call fails before any statement is built", () => {
  const v = { address: "proj:X", params: { env: { type: "string", default: "IN1", allowed: ["IN1", "IN2"] } } as Record<string, VerbParam> };
  assert.throws(() => bindArgs(v, { env: "PRD" }), /proj:X: env: "PRD" is not one of IN1, IN2/);
  assert.throws(() => bindArgs(v, { env: "in2" }), /is not one of/);
  assert.deepEqual(bindArgs(v, { env: "IN2" }), { env: "IN2" });
  // decimals compare as numbers
  const d = { address: "proj:X", params: { r: { type: "decimal", allowed: [1.5] } } as Record<string, VerbParam> };
  assert.deepEqual(bindArgs(d, { r: "1.50" }), { r: "1.50" });
  assert.throws(() => bindArgs(d, { r: "1.51" }), /is not one of 1\.5/);
});

test("verbs: substitute validates what it splices, even values that skipped bindArgs", () => {
  assert.throws(() => substitute("DELETE FROM T WHERE ID = ${n}", "sql", { n: { type: "integer" } }, { n: "0 OR 1=1" }), /\$\{n\}: "0 OR 1=1" is not an integer/);
  assert.throws(() => substitute("SELECT * FROM ORD${e}.T", "sql", { e: { type: "string", allowed: ["IN1"] } }, { e: "IN1.T; DROP TABLE X --" }), /is not one of IN1/);
  assert.throws(() => substitute("VALUES :n", "sql", { n: { type: "integer" } }, { n: "1 OR 1=1" }), /:n: "1 OR 1=1" is not an integer/);
});

test("verbs: a nested arg that is exactly ${p} passes the typed value; types must match at load", () => {
  const callee = "name: CALLEE\ndescription: d\nparams:\n  flag: { type: boolean }\n  who: { type: string }\nsteps:\n  - sql: VALUES (:flag, :who)\n";
  const caller = "name: CALLER\ndescription: d\nparams:\n  on: { type: boolean, default: true }\n  name: { type: string, default: \"x' or '1'='1\" }\nsteps:\n  - verb: CALLEE\n    args: { flag: \"${on}\", who: \"${name}\" }\n";
  const wrong = "name: WRONG\ndescription: d\nparams:\n  n: { type: integer, default: 1 }\nsteps:\n  - verb: CALLEE\n    args: { flag: \"${n}\", who: a }\n";
  const set = loadVerbs(verbRoot({ [P + "callee.yaml"]: callee, [P + "caller.yaml"]: caller, [P + "wrong.yaml"]: wrong }).src);
  assert.deepEqual(addresses(set), ["proj:CALLEE", "proj:CALLER"]);
  assert.match(set.errors.join("\n"), /wrong\.yaml: steps\.0\.args\.flag: n is integer but proj:CALLEE takes flag as boolean/);
  const outer = resolveVerb(set, "CALLER");
  const inner = resolveVerb(set, "CALLEE");
  const args = callArgs(outer.steps[0], outer.params, bindArgs(outer));
  assert.deepEqual(args, { flag: true, who: "x' or '1'='1" });
  const values = bindArgs(inner, args);
  assert.deepEqual(values, { flag: true, who: "x' or '1'='1" });
  assert.deepEqual(substitute(inner.steps[0].sql!, "sql", inner.params, values), { text: "VALUES (?, ?)", params: [true, "x' or '1'='1"] });
  // mixed text stays text
  assert.deepEqual(callArgs({ args: { who: "a${on}" } }, outer.params, { on: false, name: "n" }), { who: "aFALSE" });
});

test("verbs: injection: x' or '1'='1 arrives as a bound value with the statement text unchanged", () => {
  const params: Record<string, VerbParam> = { name: { type: "string" } };
  const values = bindArgs({ address: "proj:X", params }, { name: "x' or '1'='1" });
  const sql = `SELECT * FROM T WHERE A = :name AND B = ':name' AND "C:name" = 1 -- :name\nAND /* :name */ D = 1`;
  assert.deepEqual(substitute(sql, "sql", params, values), {
    text: `SELECT * FROM T WHERE A = ? AND B = ':name' AND "C:name" = 1 -- :name\nAND /* :name */ D = 1`,
    params: ["x' or '1'='1"],
  });
});

test("verbs: typed values are validated, and what is not one is refused", () => {
  const p = (type: VerbParam["type"]) => ({ address: "proj:X", params: { v: { type } as VerbParam } });
  const bad = [["integer", "1 OR 1=1"], ["integer", 1.5], ["integer", "9007199254740993"], ["integer", Infinity], ["decimal", "1;DROP"], ["decimal", NaN], ["decimal", Infinity], ["decimal", 1e21], ["decimal", "1e5"], ["date", "2026-01-01' OR"], ["date", "2026-02-30"], ["date", "0000-01-01"], ["date", 20260101], ["boolean", "true"], ["boolean", 1], ["string", 42]] as const;
  for (const [type, v] of bad) assert.throws(() => bindArgs(p(type), { v }), /^Error: proj:X: v: .+ is not /, `${type} ${String(v)}`);
  const good = [["integer", "007", 7], ["integer", -3, -3], ["decimal", "12.50", "12.50"], ["decimal", -0.5, "-0.5"], ["date", "2024-02-29", "2024-02-29"], ["date", "0001-01-01", "0001-01-01"], ["boolean", false, false], ["string", "", ""]] as const;
  for (const [type, v, want] of good) assert.deepEqual(bindArgs(p(type), { v }), { v: want }, `${type} ${String(v)}`);
  assert.throws(() => bindArgs(p("integer")), /v has no value and no default/);
  assert.throws(() => bindArgs(p("integer"), { v: 1, w: 2 }), /w is not a parameter/);
  assert.throws(() => bindArgs(p("integer"), { constructor: 1, v: 1 }), /constructor is not a parameter/);
  assert.equal(substitute("VALUES ${b}", "sql", { b: { type: "boolean" } }, { b: true }).text, "VALUES TRUE");
});

test("verbs: a name parameter is an upper cased object name; anything else is refused naming it", () => {
  const p = { address: "proj:X", params: { v: { type: "name" } as VerbParam } };
  for (const [v, want] of [["ordval", "ORDVAL"], ["$A#b@_1", "$A#B@_1"], ["ABCDEFGHIJ", "ABCDEFGHIJ"]] as const) assert.deepEqual(bindArgs(p, { v }), { v: want }, v);
  for (const v of ["A'B", "A B", "A(B)", "A&B", "A,B", "A/B", "A*B", "A.B", "A.", "", "1AB", "ABCDEFGHIJK", 7, true]) assert.throws(() => bindArgs(p, { v }), /^Error: proj:X: v: .+ is not an object name/, String(v));
  // allowed values are validated as names and compared upper cased
  const ok = { address: "proj:X", params: { v: { type: "name", allowed: ["ordhdr"] } as VerbParam } };
  assert.deepEqual(bindArgs(ok, { v: "OrdHdr" }), { v: "ORDHDR" });
  assert.throws(() => bindArgs(ok, { v: "other" }), /not one of/);
  const bad = loadVerbs(verbRoot({ [P + "x.yaml"]: "name: X\ndescription: d\nparams:\n  v: { type: name, allowed: [\"A B\"] }\nsteps:\n  - sql: VALUES :v\n" }).src);
  assert.match(bad.errors.join("\n"), /params\.v\.allowed\.0: "A B" is not an object name/);
});

test("verbs: in SQL outside quotes a name substitutes as an identifier or keyword, never a qualified name", () => {
  const params = { u: { type: "name" } as VerbParam };
  const p = { address: "proj:X", params };
  const sql = (t: string, u: string) => substitute(t, "sql", params, bindArgs(p, { u })).text;
  assert.equal(sql("GRANT SELECT ON ORDLIB.ORDHDR TO ${u}", "public"), "GRANT SELECT ON ORDLIB.ORDHDR TO PUBLIC"); // a keyword, not a user: use :u or '${u}' for values
  assert.equal(sql("SET SCHEMA ${u}", "user"), "SET SCHEMA USER");
  assert.equal(sql("SELECT * FROM QTEMP.${u}", "t1"), "SELECT * FROM QTEMP.T1");
  for (const u of ["A.B", "A."]) assert.throws(() => sql("SELECT * FROM QTEMP.${u}", u), /is not an object name/, u); // no three-part name, no unclosed CL comment
});

test("verbs: ${member} of type name loads in CL, inside or outside quotes; a string without allowed is still refused", () => {
  const verb = (type: string, step: string) => `name: X\ndescription: d\nparams:\n  member: { type: ${type} }\nsteps:\n  - cl: ${step}\n`;
  const loads = (type: string, step: string) => loadVerbs(verbRoot({ [P + "x.yaml"]: verb(type, step) }).src);
  for (const step of ["\"CMPRD/CMCHKOUT TASK(T1) MBR(${member})\"", "\"CMPRD/CMCHKOUT TASK(T1) MBR('${member}')\""]) {
    const set = loads("name", step);
    assert.deepEqual(set.errors, [], step);
    assert.equal(substitute(resolveVerb(set, "X").steps[0].cl!, "cl", resolveVerb(set, "X").params, bindArgs(resolveVerb(set, "X"), { member: "ordval" })).text, step.slice(1, -1).replace("${member}", "ORDVAL"));
  }
  assert.match(loads("string", "\"CMPRD/CMCHKOUT MBR(${member})\"").errors.join("\n"), /\$\{member\}: parameter member is a string with no allowed list, so it would be free text; for an object name give it type name/);
});

test("verbs: a name parameter in a command's library slot is decided by its environment like a literal", async () => {
  const set = loadVerbs(verbRoot({ [P + "x.yaml"]: "name: X\ndescription: d\nparams:\n  lib: { type: name }\nsteps:\n  - cl: CLRPFM FILE(${lib}/ORD)\n" }).src);
  assert.deepEqual(set.errors, []);
  const run = async (lib: string, who: Identity) => (await decideVerb(planVerb(set, "X", { lib }), who, D4, lookups())).statements[0].decision.decision; // observe mode would still run a deny, so look at the decision
  assert.equal(await run("inord", as("dev", "dev")), "allow");
  assert.equal(await run("lvord", as("dev", "dev")), "deny"); // live env: no rule allows it
  assert.equal(await run("paylib", as("dev", "dev")), "deny"); // blocked env
  assert.equal(await run("inord", as("analyst", "prod")), "deny");
});

test("verbs: templates are refused at load where substitution would be unsafe or wrong", () => {
  const cases: [string, string, RegExp][] = [
    ["n: { type: integer }", 'sql: "VALUES 1 -- ${n}"', /steps\.0\.sql: \$\{n\} is inside a comment/],
    ["n: { type: integer }", 'sql: "VALUES 1 /* ${n} */"', /\$\{n\} is inside a comment/],
    ["n: { type: integer }", 'sql: "VALUES ?"', /a \? marker: write :name/],
    ["n: { type: integer }", 'sql: "VALUES ${m}"', /\$\{m\} is not a parameter/],
    ["n: { type: integer }", 'sql: "VALUES ${n"', /\$\{ must be \$\{name\}/],
    ["n: { type: integer }", 'cl: "CALL PGM(P) PARM(:n)"', /steps\.0\.cl: :n: CL has no bound values/],
    ["d: { type: date }", 'sql: "VALUES ${d}"', /a date outside quotes/],
    ["x: { type: string, allowed: [\"O'BRIEN\"] }", 'cl: "CALL PGM(P) PARM(${x})"', /outside quotes and an allowed value holds a quote/],
    // zod 4's number refuses Infinity itself, so the schema stops it before the typed check; 1e21 still reaches that check
    ["n: { type: decimal, default: .inf }", 'sql: "VALUES :n"', /params\.n\.default: Invalid input/],
    ["n: { type: decimal, default: 1e21 }", 'sql: "VALUES :n"', /params\.n\.default: 1e\+21 is not a decimal number/],
    ["n: { type: integer, allowed: [1, two] }", 'sql: "VALUES :n"', /params\.n\.allowed\.1: "two" is not an integer/],
    ["s: { type: string, allowed: [01] }", 'sql: "VALUES :s"', /params\.s\.allowed\.0: 1 is not a string/],
    ["s: { type: string }", 'verb: OTHER\n    args: { t: "x${s}" }', /steps\.0\.args\.t: \$\{s\}: parameter s is a string with no allowed list/],
    ["s: { type: string }", 'verb: OTHER\n    args: { t: "${q}" }', /steps\.0\.args\.t: \$\{q\} is not a parameter/],
    ["b: { type: boolean }", 'cl: "CHGJOB LOG(${b})"', /steps\.0\.cl: \$\{b\}: a boolean has no CL form; use a string parameter with allowed: \['\*YES', '\*NO'\]/],
    ["n: { type: integer, required: false }", 'sql: "VALUES :n"', /params\.n\.required: false needs a default/],
    ["n: { type: integer, required: true, default: 1 }", 'sql: "VALUES :n"', /params\.n\.required: true with a default/],
    ["n: { type: integer }", "expect: { sql: VALUES 1, equals: {} }", /steps\.0\.expect\.equals: name at least one column/],
    ["n: { type: integer }", 'sql: "VALUES :n; VALUES :n"', /steps\.0\.sql: one SQL statement per step/],
    ["n: { type: integer }", 'sql: "VALUES :n\\nCL: DLTLIB X"', /steps\.0\.sql: one SQL statement per step/],
    ["n: { type: integer }", "expect: { sql: \"VALUES 'a\", empty: true }", /steps\.0\.expect\.sql: a string literal is never closed/],
  ];
  for (const [param, step, re] of cases) {
    const set = loadVerbs(verbRoot({ [P + "x.yaml"]: `name: X\ndescription: d\nparams:\n  ${param}\nsteps:\n  - ${step}\n` }).src);
    assert.deepEqual(set.verbs, [], step);
    assert.match(set.errors.join("\n"), re, step);
  }
});

test("verbs: ${p} doubles quotes inside literals and refuses a value that would start a comment", () => {
  const x: Record<string, VerbParam> = { x: { type: "string", allowed: ["O'BRIEN", "IN1"] } };
  assert.deepEqual(substitute("CALL PGM(P) PARM('${x}')", "cl", x, { x: "O'BRIEN" }), { text: "CALL PGM(P) PARM('O''BRIEN')", params: [] });
  assert.equal(substitute("SELECT * FROM T WHERE N = '${x}'", "sql", x, { x: "O'BRIEN" }).text, "SELECT * FROM T WHERE N = 'O''BRIEN'");
  assert.throws(() => substitute("CALL PGM(P) PARM(${x})", "cl", x, { x: "IN1" }), /outside quotes and an allowed value holds a quote/);
  const lib: Record<string, VerbParam> = { lib: { type: "string", allowed: ["IN1"] } };
  assert.equal(substitute("DSPOBJD OBJ(ORD${lib}/*ALL) OBJTYPE(*ALL) OUTFILE(ORD${lib}/OBJS)", "cl", lib, { lib: "IN1" }).text, "DSPOBJD OBJ(ORDIN1/*ALL) OBJTYPE(*ALL) OUTFILE(ORDIN1/OBJS)");
  const n: Record<string, VerbParam> = { n: { type: "integer" } };
  assert.throws(() => substitute("DELETE FROM T WHERE A > 1 -${n}\nAND B = 2", "sql", n, { n: -1 }), /would start a comment/);
  assert.equal(substitute("DELETE FROM T WHERE A > 1 - ${n}", "sql", n, { n: -1 }).text, "DELETE FROM T WHERE A > 1 - -1");
  assert.throws(() => substitute("VALUES :n", "sql", n, {}), /parameter n has no value/);
  assert.equal(substitute("${lib}", "arg", lib, { lib: "IN1" }).text, "IN1");
  assert.equal(substitute("VALUES 1;", "sql", n, {}).text, "VALUES 1", "the splitter's statement, no trailing ;");
  const semi: Record<string, VerbParam> = { s: { type: "string", allowed: ["IN1; DELETE FROM T"] } };
  assert.throws(() => substitute("SELECT * FROM ORD${s}.T", "sql", semi, { s: "IN1; DELETE FROM T" }), /substituted: one SQL statement per step/);
});

// --- planning and deciding a verb run (verbs spec; task 2.1, design D2) ---

const W_VERB = `name: W
description: write and check
params:
  k: { type: integer, default: 1 }
setup:
  - id: seed
    requires_absent: "SELECT 1 FROM INORD.T WHERE K = :k"
    sql: "INSERT INTO INORD.T (K) VALUES (:k)"
steps:
  - cl: "CALL PGM(INORD/P) PARM('\${k}')"
  - verb: INNER
    args: { n: "\${k}" }
  - expect: { sql: "SELECT K FROM INORD.T WHERE K = :k", rows: 1 }
cleanup:
  - { undoes: seed, sql: "DELETE FROM INORD.T WHERE K = :k" }
`;
const INNER_VERB = "name: INNER\ndescription: d\nparams:\n  n: { type: integer }\nsteps:\n  - sql: UPDATE INORD.T SET S = 'X' WHERE K = :n\n";

test("verbs: a plan binds and substitutes every list and nested verb, in run order", async () => {
  const set = loadVerbs(verbRoot({ [P + "w.yaml"]: W_VERB, [P + "inner.yaml"]: INNER_VERB }).src);
  assert.deepEqual(set.errors, []);
  const plan = planVerb(set, "W", { k: 7 });
  const list = plannedStatements(plan);
  assert.deepEqual(
    list.map((s) => [s.verb, s.where, s.kind, s.text, s.params]),
    [
      ["proj:W", "setup.0.requires_absent", "sql", "SELECT 1 FROM INORD.T WHERE K = ?", [7]],
      ["proj:W", "setup.0", "sql", "INSERT INTO INORD.T (K) VALUES (?)", [7]],
      ["proj:W", "steps.0", "cl", "CALL PGM(INORD/P) PARM('7')", []],
      ["proj:INNER", "steps.0", "sql", "UPDATE INORD.T SET S = 'X' WHERE K = ?", [7]],
      ["proj:W", "steps.2.expect", "sql", "SELECT K FROM INORD.T WHERE K = ?", [7]],
      ["proj:W", "cleanup.0", "sql", "DELETE FROM INORD.T WHERE K = ?", [7]],
    ],
  );
  const r = await decideVerb(plan, as("dev", "dev"), D4, lookups());
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.statements.map((s) => s.decision.decision), ["allow", "allow", "allow", "allow", "allow", "allow"]);
  assert.deepEqual(r.statements[1].statement.operations.map((o) => `${o.class} ${o.object?.lib}.${o.object?.name}`), ["write INORD.T"]);
  const analyst = await decideVerb(plan, as("analyst", "prod"), D4, lookups());
  assert.deepEqual(analyst.statements.map((s) => s.decision.effective), ["allow", "deny", "deny", "deny", "allow", "deny"]);
});

test("verbs: a nested verb's bad value fails the plan before any statement could be sent", () => {
  const callee = "name: CALLEE\ndescription: d\nparams:\n  env: { type: string, allowed: [IN1] }\nsteps:\n  - sql: VALUES :env\n";
  const caller = "name: CALLER\ndescription: d\nparams:\n  n: { type: integer, default: 1 }\nsteps:\n  - sql: DELETE FROM INORD.T\n  - verb: CALLEE\n    args: { env: \"IN${n}\" }\n";
  const set = loadVerbs(verbRoot({ [P + "callee.yaml"]: callee, [P + "caller.yaml"]: caller }).src);
  assert.deepEqual(set.errors, []);
  assert.equal(plannedStatements(planVerb(set, "CALLER")).length, 2);
  assert.throws(() => planVerb(set, "CALLER", { n: 2 }), /proj:CALLEE: env: "IN2" is not one of IN1/);
});

test("verbs: the call chain is bounded at plan time too, with MAX_VERB_DEPTH", () => {
  const files: Record<string, string> = {};
  for (let i = 1; i <= 6; i++) files[`${P}v${i}.yaml`] = i < 5 ? calls(`V${i}`, `V${i + 1}`) : verbYaml(`V${i}`);
  const set = loadVerbs(verbRoot(files).src);
  assert.equal(plannedStatements(planVerb(set, "V1")).length, 1);
  resolveVerb(set, "V5").steps.push({ verb: "V6" }); // a set changed after loading
  assert.throws(() => planVerb(set, "V1"), new RegExp(`more than ${MAX_VERB_DEPTH} verbs in one call chain: proj:V1 → .* → proj:V6`));
});

test("verbs: requires_absent and expect queries must only read, by the classifier, not the first word", async () => {
  const sneaky = (key: string, q: string) => `name: S\ndescription: d\nparams:\n  k: { type: integer, default: 1 }\nsetup:\n  - id: s\n    ${key === "requires_absent" ? `requires_absent: "${q}"\n    ` : ""}sql: INSERT INTO INORD.T (K) VALUES (:k)\nsteps:\n  - ${key === "expect" ? `expect: { sql: "${q}", empty: true }` : "sql: VALUES 1"}\n`;
  const q = "SELECT * FROM OLD TABLE (DELETE FROM INORD.T WHERE K = :k)";
  for (const key of ["requires_absent", "expect"]) {
    const set = loadVerbs(verbRoot({ [P + "s.yaml"]: sneaky(key, q) }).src);
    assert.deepEqual(set.errors, [], key);
    const r = await decideVerb(planVerb(set, "S"), as("dev", "dev"), D4, lookups());
    assert.equal(r.refusals.length, 1, key);
    assert.match(r.refusals[0], new RegExp(`proj:S (setup\\.0\\.requires_absent|steps\\.0\\.expect): a ${key} query must only read, but it is write INORD\\.T`));
  }
});

test("policy tests: a verb case decides every statement the verb would send", async () => {
  const { root, src } = verbRoot({ [P + "w.yaml"]: W_VERB, [P + "inner.yaml"]: INNER_VERB });
  const set = loadVerbs({ cwd: src.cwd });
  const cases = parsePolicyTests(
    `- name: dev runs it
  as: { user: JDOE, groups: [GRPDEV], partition: dev }
  verb: W
  args: { k: 5 }
  expect: [allow, allow, allow, allow, allow, allow]
- name: analyst cannot
  as: { user: ANL01, groups: [GRPANL], partition: prod }
  verb: proj:W
  expect: deny
- name: wrong
  as: { user: ANL01, groups: [GRPANL], partition: prod }
  verb: W
  expect: allow
`,
    join(root, "t.yaml"),
  );
  const [dev, analyst, wrong] = await runPolicyTests(D4, cases, set);
  assert.equal(dev.ok, true, describeFailure(dev));
  assert.equal(analyst.ok, true, describeFailure(analyst));
  assert.equal(wrong.ok, false);
  assert.match(describeFailure(wrong), /statement 2: proj:W setup\.0: INSERT INTO INORD\.T \(K\) VALUES \(\?\)\n    deny/);
  await assert.rejects(runPolicyTests(D4, parsePolicyTests("- { name: bad, as: { user: X }, verb: W, args: { k: two }, expect: allow }\n", "t.yaml"), set), /case "bad": proj:W: k: "two" is not an integer/);
  // a requires_absent query that writes is a deny, whatever the rules say
  const sneaky = loadVerbs({ cwd: verbRoot({ [P + "w.yaml"]: W_VERB.replace("SELECT 1 FROM INORD.T WHERE K = :k", "SELECT * FROM OLD TABLE (DELETE FROM INORD.T WHERE K = :k)"), [P + "inner.yaml"]: INNER_VERB }).src.cwd });
  const [ro] = await runPolicyTests(D4, parsePolicyTests("- { name: ro, as: { user: JDOE, groups: [GRPDEV], partition: dev }, verb: W, expect: allow }\n", "t.yaml"), sneaky);
  assert.equal(ro.ok, false);
  assert.match(describeFailure(ro), /statement 1: proj:W setup\.0\.requires_absent: .*\n    deny .*\n    - proj:W setup\.0\.requires_absent: a requires_absent query must only read, but it is write INORD\.T/);
});

test("policy tests: an undeclared-parameter warning rides on the result, script and verb, and ok is unchanged", async () => {
  const WARNING = /^CALL XYZKW\(\): the command table does not declare this parameter/;
  const as = "as: { user: JDOE, groups: [GRPDEV], partition: dev }";
  const [plain, withKw] = await runPolicyTests(D4, parsePolicyTests(`- { name: plain, ${as}, script: "CL: CALL PGM(INORD/P)", expect: allow }\n- { name: kw, ${as}, script: "CL: CALL PGM(INORD/P) XYZKW(PRODLIB)", expect: allow }\n`, "t.yaml"));
  assert.equal(plain.statements[0].warnings, undefined);
  assert.equal(withKw.ok, true);
  assert.match(withKw.statements[0].warnings![0], WARNING);
  assert.match(describeFailure(withKw), /\n {4}! CALL XYZKW\(\): /);
  const set = loadVerbs(verbRoot({ [P + "c.yaml"]: verbYaml("C", "  - cl: CALL PGM(INORD/P) XYZKW(PRODLIB)") }).src);
  const [v] = await runPolicyTests(D4, parsePolicyTests(`- { name: v, ${as}, verb: C, expect: allow }\n`, "t.yaml"), set);
  assert.equal(v.ok, true);
  assert.match(v.statements[0].warnings![0], WARNING);
  assert.match(describeFailure(v), /\n {4}! CALL XYZKW\(\): /);
});

test("verbs: verbs decided together see what earlier ones set up: a QTEMP alias, a changed current library", async () => {
  const set = loadVerbs(
    verbRoot({
      [P + "a.yaml"]: verbYaml("A", "  - sql: CREATE ALIAS QTEMP.A FOR LVORD.ORD"),
      [P + "b.yaml"]: verbYaml("B", "  - sql: DELETE FROM QTEMP.A"),
      [P + "c.yaml"]: verbYaml("C", "  - cl: CHGCURLIB CURLIB(LVORD)"),
      [P + "d.yaml"]: verbYaml("D", "  - cl: CLRPFM FILE(*CURLIB/ORD)"),
    }).src,
  );
  const who = as("dev", "prod");
  const alone = await decideVerb(planVerb(set, "B"), who, D4, lookups());
  assert.equal(alone.statements[0].decision.effective, "allow", "alone, QTEMP.A is only a scratch table");
  const r = await decidePlans([planVerb(set, "A"), planVerb(set, "B")], who, D4, lookups());
  assert.deepEqual(r.statements.map((v) => v.map((s) => s.decision.effective)), [["allow"], ["deny"]]);
  const cur = await decidePlans([planVerb(set, "C"), planVerb(set, "D")], who, D4, lookups({ curlib: "DVORD" }));
  assert.deepEqual(cur.statements.map((v) => v.map((s) => s.decision.effective)), [["allow"], ["deny"]]);
});

// --- run log (run-log spec; task 4.1) ---

test("redact: password-bearing CL parameters become ***, wherever they stand", () => {
  const rows: [string, string][] = [
    ["CHGUSRPRF USRPRF(X) PASSWORD(SECRET1)", "CHGUSRPRF USRPRF(X) PASSWORD(***)"],
    ["chgusrprf usrprf(x) password ( 'a)b' )", "chgusrprf usrprf(x) password (***)"],
    ["CHGPWD CURPWD(OLD1) NEWPWD(NEW1)", "CHGPWD CURPWD(***) NEWPWD(***)"],
    ["CHGDSTPWD PWD(X1) PWRDVPWD(Y1)", "CHGDSTPWD PWD(***) PWRDVPWD(***)"],
    ["CHGUSRPRF JDOE SECRET1", "CHGUSRPRF JDOE ***"],
    ["QSYS/CRTUSRPRF JDOE 'SEC RET'", "QSYS/CRTUSRPRF JDOE '***'"],
    ["CHGUSRPRF JDOE STATUS(*ENABLED)", "CHGUSRPRF JDOE STATUS(*ENABLED)"],
    ["CALL QSYS2.QCMDEXC('CHGUSRPRF X PASSWORD(''S3'')')", "CALL QSYS2.QCMDEXC('CHGUSRPRF X PASSWORD(***)')"],
    ["CALL QSYS2.QCMDEXC('CHGUSRPRF JDOE S3')", "CALL QSYS2.QCMDEXC('CHGUSRPRF JDOE ***')"],
    ["CHGUSRPRF X PASSWORD(UNCLOSED", "CHGUSRPRF X PASSWORD(***"],
    ["CHGUSRPRF USRPRF(BOB) /* Bob's reset */ PASSWORD('Winter25')", "CHGUSRPRF USRPRF(BOB) /* *** */ PASSWORD(***)"],
    ["RUNRMTCMD CMD('dir') RMTLOCNAME(HOST1 *IP) RMTUSER(BOB) RMTPWD(Winter25)", "RUNRMTCMD CMD('dir') RMTLOCNAME(HOST1 *IP) RMTUSER(BOB) RMTPWD(***)"],
    ["CHGUSRPRF JDOE /* new */ SECRET1", "CHGUSRPRF JDOE /* *** */ ***"],
    ["CHGUSRPRF /* x */ JDOE SECRET1", "CHGUSRPRF /* *** */ JDOE ***"],
    ["CALL QSYS2.QCMDEXC('CHGUSRPRF JDOE /* x */ S3')", "CALL QSYS2.QCMDEXC('CHGUSRPRF JDOE /* *** */ ***')"],
    ["CHGUSRPRF 'JDOE' SECRET1", "CHGUSRPRF 'JDOE' ***"],
    ["CALL QSYS2.QCMDEXC('CHGUSRPRF JDOE ''NEWPW1''')", "CALL QSYS2.QCMDEXC('CHGUSRPRF JDOE ''***''')"],
    ["CALL QSYS2.QCMDEXC('CHGUSRPRF X PASSWORD(''pa)ss'')')", "CALL QSYS2.QCMDEXC('CHGUSRPRF X PASSWORD(***)')"],
    ["SELECT 1 FROM A.T WHERE CMD LIKE '%PASSWORD(%' AND X = 1", "SELECT 1 FROM A.T WHERE CMD LIKE '%PASSWORD(***' AND X = 1"],
  ];
  for (const [text, want] of rows) assert.equal(redact(text), want, text);
  for (const [text] of rows.slice(-3, -1)) assert.ok(!/NEWPW1|pa\)ss/.test(redact(text)), text);
});

test("redact: SQL nested in a RUNSQL literal is redacted as SQL, quotes doubled again", () => {
  const rows: [string, string][] = [
    ["RUNSQL SQL('SET ENCRYPTION PASSWORD = ''x''')", "RUNSQL SQL('SET ENCRYPTION PASSWORD = ''***''')"],
    ["RUNSQL SQL('CONNECT TO R USER U USING ''pw''')", "RUNSQL SQL('CONNECT TO R USER U USING ''***''')"],
    ["QSYS/RUNSQL COMMIT(*NONE) SQL('SELECT DECRYPT_CHAR(C, ''k1'') FROM A.T') NAMING(*SQL)", "QSYS/RUNSQL COMMIT(*NONE) SQL('SELECT DECRYPT_CHAR(C, ''***'') FROM A.T') NAMING(*SQL)"],
    ["runsql 'SET ENCRYPTION PASSWORD ''y'''", "runsql 'SET ENCRYPTION PASSWORD ''***'''"],
    ["CALL QSYS2.QCMDEXC('RUNSQL SQL(''SET ENCRYPTION PASSWORD = ''''z'''''')')", "CALL QSYS2.QCMDEXC('RUNSQL SQL(''SET ENCRYPTION PASSWORD = ''''***'''''')')"],
    ["RUNSQL SQL('SELECT ''PASSWORD = '' FROM A.T')", "RUNSQL SQL('SELECT ''PASSWORD = '' FROM A.T')"],
    ["SELECT 'RUNSQL SQL(x)' FROM A.T", "SELECT 'RUNSQL SQL(x)' FROM A.T"],
    ["RUNSQL /* Bob's */ SQL('SET ENCRYPTION PASSWORD = ''x''')", "RUNSQL /* *** */ SQL('SET ENCRYPTION PASSWORD = ''***''')"],
  ];
  for (const [text, want] of rows) assert.equal(redact(text), want, text);
});

test("redact: every literal's content is redacted as SQL too, whatever command or statement holds it", () => {
  const rows: [string, string][] = [
    ["EXECUTE IMMEDIATE 'SET ENCRYPTION PASSWORD = ''Winter25'''", "EXECUTE IMMEDIATE 'SET ENCRYPTION PASSWORD = ''***'''"],
    ["PREPARE S FROM 'SET ENCRYPTION PASSWORD = ''Winter25'''", "PREPARE S FROM 'SET ENCRYPTION PASSWORD = ''***'''"],
    ["RUNSQL DATSEP('/') SQL('SET ENCRYPTION PASSWORD = ''Winter25''')", "RUNSQL DATSEP('/') SQL('SET ENCRYPTION PASSWORD = ''***''')"],
  ];
  for (const [text, want] of rows) assert.equal(redact(text), want, text);
  const text = "RUNQRY2 STMT('SET ENCRYPTION PASSWORD = ''Winter25''')";
  assert.equal(redact(text), "RUNQRY2 STMT('SET ENCRYPTION PASSWORD = ''***''')", "a policy's own nested_sql: command needs no table");
  const p = parsePolicy("version: 1\ncommands:\n  RUNQRY2: { class: read, nested_sql: STMT }\nrules:\n  - { decision: allow }\n", "p.yaml");
  const c = { statement: { kind: "cl" as const, text, display: text }, decision: decide([], { user: "JDOE" }, p), outcome: "ok" };
  const [line] = runLogLines({ server: "dev1", tool: "run_script", identity: { user: "JDOE" }, lookups: {}, statements: [c] }, p);
  assert.ok(!line.text.includes("Winter25"), line.text);
});

test("redact: ENCRYPT_* and DECRYPT_* password arguments become ***, outside literals", () => {
  const rows: [string, string][] = [
    ["INSERT INTO A.T VALUES ENCRYPT_RC2('data', 'pw4', 'hint')", "INSERT INTO A.T VALUES ENCRYPT_RC2('data', '***', 'hint')"],
    ["SELECT DECRYPT_CHAR(C, :PW) FROM A.T", "SELECT DECRYPT_CHAR(C, ***) FROM A.T"],
    ["SELECT encrypt_aes(SUBSTR(C, 1, 2),'p,w') FROM A.T", "SELECT encrypt_aes(SUBSTR(C, 1, 2),'***') FROM A.T"],
    ["SELECT ENCRYPT_TDES(C, (SELECT P FROM B.K)) FROM A.T", "SELECT ENCRYPT_TDES(C, (SELECT P FROM B.K)) FROM A.T"],
    ["SELECT 'ENCRYPT_RC2(x, y)' FROM A.T", "SELECT 'ENCRYPT_RC2(x, ***)' FROM A.T"],
    ["SELECT DECRYPT_BIT(ENCRYPT_RC2(C, 'a1'), 'b2') FROM A.T", "SELECT DECRYPT_BIT(ENCRYPT_RC2(C, '***'), '***') FROM A.T"],
    ["SELECT /* Bob's key */ DECRYPT_CHAR(C, 'k1') FROM A.T", "SELECT /* *** */ DECRYPT_CHAR(C, '***') FROM A.T"],
    ["SELECT DECRYPT_CHAR(C /* Bob's */, 'k2') FROM A.T", "SELECT DECRYPT_CHAR(C /* *** */, '***') FROM A.T"],
    ["SELECT DECRYPT_CHAR(C, UPPER(TRIM('k3')) || :K4, 'hint') FROM A.T", "SELECT DECRYPT_CHAR(C, UPPER(TRIM('***')) || :K4, 'hint') FROM A.T"],
  ];
  for (const [text, want] of rows) assert.equal(redact(text), want, text);
});

test("redact: password-bearing SQL clauses become ***, quotes kept", () => {
  const rows: [string, string][] = [
    ["CREATE USER X IDENTIFIED BY 'pw1'", "CREATE USER X IDENTIFIED BY '***'"],
    ["SET ENCRYPTION PASSWORD = 'pw2' WITH HINT 'h'", "SET ENCRYPTION PASSWORD = '***' WITH HINT 'h'"],
    ["set encryption password :pw", "set encryption password ***"],
    ["UPDATE A.T SET PASSWORD = 'it''s' WHERE ID = 1", "UPDATE A.T SET PASSWORD = '***' WHERE ID = 1"],
    ["CONNECT TO PRODRDB USER JDOE USING 'pw3'", "CONNECT TO PRODRDB USER JDOE USING '***'"],
    ["-- PASSWORD = hunter2\nSELECT 1 FROM A.T", "-- ***\nSELECT 1 FROM A.T"],
    ["DELETE FROM DVORD.T /* PASSWORD( see ticket */ WHERE ID = 7", "DELETE FROM DVORD.T /* *** */ WHERE ID = 7"],
    ["SELECT \"PWD(\" FROM LVORD.T", "SELECT \"PWD(\" FROM LVORD.T"],
    ["UPDATE APPLIB.USERS SET STATUS = 'X' /* PASSWORD = Winter25 */ WHERE ID = 7", "UPDATE APPLIB.USERS SET STATUS = 'X' /* *** */ WHERE ID = 7"],
    ["-- new PASSWORD = Winter25 for BOB", "-- ***"],
    ["SET ENCRYPTION /* k */ PASSWORD 'Winter25'", "SET ENCRYPTION /* *** */ PASSWORD '***'"],
    ["CONNECT TO PRODRDB /* p */ USER JDOE USING 'Winter25'", "CONNECT TO PRODRDB /* *** */ USER JDOE USING '***'"],
    ["SELECT \"PASSWORD = \" FROM LVORD.T WHERE \"IDENTIFIED BY\" = 1", "SELECT \"PASSWORD = \" FROM LVORD.T WHERE \"IDENTIFIED BY\" = 1"],
    ["MERGE INTO A.T USING (SELECT 1 FROM B.X) S ON 1 = 1", "MERGE INTO A.T USING (SELECT 1 FROM B.X) S ON 1 = 1"],
    ["UPDATE APPLIB.USERS /* Bob's row */ SET PASSWORD = 'Winter25' WHERE ID = 7", "UPDATE APPLIB.USERS /* *** */ SET PASSWORD = '***' WHERE ID = 7"],
    ["SET PASSWORD = HASH_SHA256('Winter25')", "SET PASSWORD = HASH_SHA256('***')"],
    ["UPDATE A.T SET PASSWORD = DVORD.HASHPW(C, :PW, 'salt') WHERE ID = 1", "UPDATE A.T SET PASSWORD = DVORD.HASHPW(C, :PW, '***') WHERE ID = 1"],
    ["UPDATE A.T SET PASSWORD = DVORD.HASHPW(C)", "UPDATE A.T SET PASSWORD = DVORD.HASHPW(C)"],
    ["SET PASSWORD = HASH(UPPER('x'))", "SET PASSWORD = HASH(UPPER('***'))"],
    ["SET ENCRYPTION PASSWORD = 'Sum' || 'mer24'", "SET ENCRYPTION PASSWORD = '***' || '***'"],
    ["UPDATE APPLIB.USERS SET PASSWORD = N'Correct Horse' WHERE ID = 7", "UPDATE APPLIB.USERS SET PASSWORD = N'***' WHERE ID = 7"],
    ["UPDATE A.T SET PASSWORD = GX'C1C2', C = 'kept' WHERE ID = 7", "UPDATE A.T SET PASSWORD = GX'***', C = 'kept' WHERE ID = 7"],
    ["SET ENCRYPTION PASSWORD = :PW WITH HINT 'h'", "SET ENCRYPTION PASSWORD = *** WITH HINT 'h'"],
    ["SET ENCRYPTION PASSWORD = CONCAT(TRIM(:P1), 'k' || 'w') WITH HINT 'h'", "SET ENCRYPTION PASSWORD = CONCAT(TRIM(:P1), '***' || '***') WITH HINT 'h'"],
    ["CREATE USER X IDENTIFIED BY LOWER(/* Bob's */ 'Pw9')", "CREATE USER X IDENTIFIED BY LOWER(/* *** */ '***')"],
    ["CONNECT USER JDOE USING :PW", "CONNECT USER JDOE USING ***"],
    ["SELECT C FROM A.T WHERE U = USER X USING 'not a password'", "SELECT C FROM A.T WHERE U = USER X USING 'not a password'"],
    ["SELECT 'PASSWORD = ' || C FROM PAYLIB.T WHERE X = 'y'", "SELECT 'PASSWORD = ' || C FROM PAYLIB.T WHERE X = 'y'"],
  ];
  for (const [text, want] of rows) assert.equal(redact(text), want, text);
});

test("redact: the redacted text classifies as the original does (replay reads it)", async () => {
  for (const script of ["CL: CHGUSRPRF USRPRF(X) PASSWORD(SECRET1)", "SET ENCRYPTION PASSWORD = 'pw2'", "CALL QSYS2.QCMDEXC('CHGUSRPRF X PASSWORD(''S3'')')", "UPDATE LVORD.T SET PASSWORD = 'x' WHERE ID = 1",
    "MERGE INTO LVORD.T USING DVORD.SRC S ON S.ID = LVORD.T.ID WHEN MATCHED THEN DELETE",
    "SELECT * FROM LVORD.T WHERE CMD LIKE '%PASSWORD(%'",
    "SELECT 'PASSWORD = ' || C FROM PAYLIB.T WHERE X = 'y'",
    "CALL QSYS2.QCMDEXC('CHGUSRPRF JDOE ''NEWPW1''')",
    "SELECT DECRYPT_CHAR(C, 'pw') FROM LVORD.T",
    "CL: RUNSQL SQL('SET ENCRYPTION PASSWORD = ''x''')",
    "CL: RUNSQL SQL('CONNECT TO R USER U USING ''pw''')",
    "CL: RUNSQL SQL('DELETE FROM LVORD.T WHERE P = ENCRYPT_RC2(''a'', ''k'')') COMMIT(*NONE)",
    "CALL QSYS2.QCMDEXC('RUNSQL SQL(''SET ENCRYPTION PASSWORD = ''''z'''''')')",
    "UPDATE APPLIB.USERS /* Bob's row */ SET PASSWORD = 'Winter25' WHERE ID = 7",
    "CL: CHGUSRPRF USRPRF(BOB) /* Bob's reset */ PASSWORD('Winter25')",
    "SELECT /* Bob's key */ DECRYPT_CHAR(C, 'k1') FROM A.T",
    "CL: RUNSQL /* Bob's */ SQL('SET ENCRYPTION PASSWORD = ''x''')",
    "UPDATE LVORD.T SET PASSWORD = HASH_SHA256('Winter25')",
    "UPDATE LVORD.T SET PASSWORD = DVORD.HASHPW(C)",
    "UPDATE LVORD.T SET PASSWORD = HASH(UPPER('x'))",
    "UPDATE LVORD.T SET PASSWORD = DVORD.HASHPW(UPPER('x'), (SELECT K FROM DVORD.KEYS))",
    "SELECT DECRYPT_CHAR(C, UPPER(TRIM('k3')) || :K4) FROM LVORD.T",
    "SET ENCRYPTION PASSWORD = 'Sum' || 'mer24'",
    "UPDATE APPLIB.USERS SET PASSWORD = N'Correct Horse' WHERE ID = 7",
    "EXECUTE IMMEDIATE 'SET ENCRYPTION PASSWORD = ''Winter25'''",
    "PREPARE S FROM 'SET ENCRYPTION PASSWORD = ''Winter25'''",
    "CL: RUNSQL DATSEP('/') SQL('SET ENCRYPTION PASSWORD = ''Winter25''')",
    "DELETE FROM DVORD.T /* PASSWORD( see ticket */ WHERE ID = 7",
    'SELECT "PWD(" FROM LVORD.T',
    "UPDATE APPLIB.USERS SET STATUS = 'X' /* PASSWORD = Winter25 */ WHERE ID = 7",
    "-- new PASSWORD = Winter25 for BOB",
    "CL: CHGUSRPRF JDOE /* new */ SECRET1",
    "CL: CHGUSRPRF /* x */ JDOE SECRET1",
    "CALL QSYS2.QCMDEXC('CHGUSRPRF JDOE /* x */ S3')",
    "SET ENCRYPTION /* k */ PASSWORD 'Winter25'",
    "CONNECT TO PRODRDB /* p */ USER JDOE USING 'Winter25'",
    "CL: CHGUSRPRF 'JDOE' SECRET1"]) {
    const a = await classify(script, d4ctx());
    const b = await classify(redact(script), d4ctx());
    assert.deepEqual(sorted(b.operations), sorted(a.operations), script);
  }
  const fn = await classify(redact("UPDATE LVORD.T SET PASSWORD = DVORD.HASHPW(C)"), d4ctx());
  assert.ok(sorted(fn.operations).includes("call DVORD.HASHPW"), sorted(fn.operations).join());
});

test("lookups: recorded answers, failures included, replay as stated answers", async () => {
  const { lookups: rec, answers } = recordLookups(lookups({ schemas: { ORDER_HISTORY: "ORDHIST" }, bases: { "QTEMP.A": [{ lib: "LVORD", name: "ORDERS" }] }, curlib: "DVORD" }));
  const script = "DELETE FROM QTEMP.A; DELETE FROM ORDER_HISTORY.T; DELETE FROM NOSUCH_SCHEMA.T;\nCL: CLRPFM FILE(*CURLIB/X)";
  const live = await classify(script, { ...d4ctx(), lookups: rec });
  assert.deepEqual(answers, { bases: { "QTEMP.A": ["LVORD.ORDERS"], "LVORD.ORDERS": [], "ORDHIST.T": [], "NOSUCH_SCHEMA.T": [], "DVORD.X": [] }, schemas: { ORDER_HISTORY: "ORDHIST", NOSUCH_SCHEMA: null }, curlib: "DVORD" });
  const again = await classify(script, { ...d4ctx(), lookups: statedLookups(JSON.parse(JSON.stringify(answers))) });
  assert.deepEqual(again.statements.map((s) => sorted(s.operations)), live.statements.map((s) => sorted(s.operations)));
  const failed = recordLookups(lookups({ basesThrow: true, curlib: null }));
  await classify("DELETE FROM QTEMP.A;\nCL: CLRPFM FILE(*CURLIB/X)", { ...d4ctx(), lookups: failed.lookups });
  assert.deepEqual(failed.answers, { bases: { "QTEMP.A": null }, curlib: null });
  // A failed alias lookup fails closed again when replayed from the recorded answers.
  const replayed = await classify("DELETE FROM QTEMP.A", { ...d4ctx(), lookups: statedLookups(failed.answers) });
  assert.deepEqual(classes(replayed), ["write", "danger"]);
  assert.equal(await statedLookups({ schemas: {} }).systemSchema("constructor"), undefined, "own keys only");
});

async function call(script: string, who: Identity, extra: { secret?: string; outcome?: string } = {}) {
  const { lookups: rec, answers } = recordLookups(lookups());
  const c = await classify(script, { ...d4ctx(), lookups: rec });
  return {
    server: "dev1",
    tool: "run_script",
    identity: who,
    lookups: answers,
    notes: c.notes,
    statements: c.statements.map((s) => ({ statement: s, decision: decide(s.operations, who, D4), outcome: extra.outcome ?? "ok" })),
    ...(extra.secret ? { secret: extra.secret } : {}),
  };
}

test("Observed deny: the line records decision deny, enforced false and the outcome", async () => {
  const [line] = runLogLines(await call("DELETE FROM LVORD.ORDERS", as("analyst", "dev"), { outcome: "3 rows" }), D4);
  assert.deepEqual([line.decision, line.effective, line.enforced, line.outcome, line.mode], ["deny", "allow", false, "3 rows", "observe"]);
  const op = line.operations[0];
  assert.deepEqual([op.decision, op.enforced, op.reason, op.env], ["deny", false, "no_rule", "live"]);
  assert.deepEqual([line.roles, line.roleSource, line.partition, line.policy, line.kind], [["analyst"], "matched", "dev", D4.hash, "sql"]);
  assert.match(line.policy, /^[0-9a-f]{64}$/);
});

test("Confirmed statement: the line records confirmed true and the outcome", async () => {
  const c = await call("DELETE FROM DVORD.T", as("dev", "dev"), { outcome: "1 row" });
  const [line] = runLogLines({ ...c, statements: [{ ...c.statements[0], confirmed: true }] }, D4);
  assert.deepEqual([line.confirmed, line.outcome, line.rule, line.operations[0].rule], [true, "1 row", 6, 6]);
});

test("Password in a command: the logged text reads PASSWORD(***); the profile password is never present", async () => {
  const c = await call("CL: CHGUSRPRF USRPRF(X) PASSWORD(SECRET1)\nSELECT 'Hunter2' FROM QTEMP.T WHERE C = 'HUNTER2'", as("dev", "dev"), { secret: "hunter2" });
  const lines = runLogLines(c, D4);
  assert.equal(lines[0].text, "CHGUSRPRF USRPRF(X) PASSWORD(***)");
  assert.equal(lines[1].text, "SELECT '***' FROM QTEMP.T WHERE C = '***'");
  const all = JSON.stringify(lines);
  assert.ok(!/SECRET1/i.test(all) && !/hunter2/i.test(all), all);
  assert.deepEqual([lines[0].call === lines[1].call, lines[0].index, lines[1].index], [true, 0, 1]);
});

test("RunLog: appends JSON lines to the day's file", async () => {
  const dir = join(tmp(), "runs");
  const log = new RunLog(dir, D4);
  log.record(await call("SELECT * FROM LVORD.T; DELETE FROM LVORD.T", as("dev", "prod")));
  log.record(await call("CL: PWRDWNSYS", as("dev", "prod")));
  const files = readdirSync(dir);
  assert.deepEqual(files, [`${new Date().toISOString().slice(0, 10)}.jsonl`]);
  const lines = readFileSync(join(dir, files[0]), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as RunLogLine);
  assert.deepEqual(lines.map((l) => [l.text, l.decision, l.enforced]), [["SELECT * FROM LVORD.T", "allow", false], ["DELETE FROM LVORD.T", "deny", true], ["PWRDWNSYS", "deny", true]]);
});

test("Read-only folder: one warning, no throw", async () => {
  const root = tmp();
  writeFileSync(join(root, "runs"), "a file where the folder should be");
  const warnings: string[] = [];
  const log = new RunLog(join(root, "runs", "deeper"), D4, (m) => warnings.push(m));
  const c = await call("DELETE FROM LVORD.T", as("dev", "prod"));
  assert.doesNotThrow(() => log.record(c));
  assert.doesNotThrow(() => log.record(c));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /run log: cannot write/);
  const other: string[] = [];
  assert.doesNotThrow(() => new RunLog(join(root, "ok"), D4, (m) => other.push(m)).record({ ...c, time: new Date(NaN) }));
  assert.equal(other.length, 1, "a line that cannot be built warns too");
});

test("RunLog: a line the profile password is taken out of is marked scrubbed; its fixed fields stay intact", async () => {
  const [line] = runLogLines(await call("SELECT * FROM LVORD.T", as("dev", "dev"), { secret: "a" }).then((c) => ({ ...c, statements: c.statements.map((s) => ({ ...s, statement: { ...s.statement, text: "SELECT A FROM LVORD.T" } })) })), D4);
  assert.deepEqual([line.scrubbed, line.decision, line.effective, line.kind, line.mode, line.roles], [true, "allow", "allow", "sql", "observe", ["dev"]]);
  assert.match(line.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!/a/i.test(line.text) && !/a/i.test(JSON.stringify(line.identity)), line.text);
  const [clean] = runLogLines(await call("SELECT * FROM LVORD.T", as("dev", "dev"), { secret: "hunter2" }), D4);
  assert.equal(clean.scrubbed, undefined, "a password that never appears marks nothing");
});

test("policy hash: covers the policy text and each command file's text", () => {
  const dir = tmp();
  const policy = join(dir, "policy.yaml");
  writeFileSync(policy, "version: 1\ncommand_files: [cm.yaml]\nrules: []\n");
  writeFileSync(join(dir, "cm.yaml"), "commands:\n  CMPRM: { class: promote }\n");
  const a = loadPolicy(policy).hash;
  writeFileSync(join(dir, "cm.yaml"), "commands:\n  CMPRM: { class: danger }\n");
  assert.notEqual(loadPolicy(policy).hash, a);
  // The shipped command table is part of what the policy means, so it is hashed too.
  const shipped = readFileSync(new URL("./commands.yaml", import.meta.url), "utf8");
  const want = createHash("sha256").update("version: 1\ncommand_files: [cm.yaml]\nrules: []\n").update("\0").update(shipped).update("\0").update("commands:\n  CMPRM: { class: danger }\n").digest("hex");
  assert.equal(loadPolicy(policy).hash, want);
});

test("RunLog: the profile password is scrubbed also where its quotes are doubled inside a literal", async () => {
  const c = await call("SELECT * FROM LVORD.T WHERE C = 'o''Brien9'", as("dev", "dev"), { secret: "o'Brien9" });
  const [line] = runLogLines(c, D4);
  assert.ok(!/brien9/i.test(JSON.stringify(line)), line.text);
  assert.equal(line.scrubbed, true);
});

// --- policy tests (policy-testing spec; task 3.1) ---

const EXAMPLE_TESTS = fileURLToPath(new URL("../../../examples/three-partitions.tests.yaml", import.meta.url));

test("Passing suite: the example's tests all pass", async () => {
  const results = await runPolicyTests(D4, loadPolicyTests(EXAMPLE_TESTS));
  assert.deepEqual(results.filter((r) => !r.ok).map(describeFailure), []);
});

test("policy tests: the example covers every role x environment allow and deny the policy has", async () => {
  const seen = new Set<string>();
  for (const r of await runPolicyTests(D4, loadPolicyTests(EXAMPLE_TESTS)))
    for (const s of r.statements)
      for (const o of s.decision.operations) if (o.env && s.decision.roles.length === 1) seen.add(`${s.decision.roles[0]}|${o.env}|${o.decision}`);
  // Every role|env|decision cell the policy can reach: one operation per role, partition,
  // environment (a library standing for it) and class.
  const reachable = new Set<string>();
  const envLibs = ["QTEMP", "ME", "PAYLIB", "QTORD", "QSYS2", "DVORD", "INORD", "SQORD", "SPORD", "LVORD", "XYZLIB", "~"];
  for (const role of ["analyst", "contractor", "dev", "qa"])
    for (const part of ["dev", "qa", "prod"])
      for (const lib of envLibs)
        for (const cls of CLASSES) {
          const who = as(role, part);
          if (lib === "~" && cls !== "read" && cls !== "call") continue; // an unqualified change has no environment
          const op: Operation = lib === "~" ? { class: cls, source: "sql", object: { name: "T" }, env: "unqualified" } : { class: cls, source: "sql", object: { lib: lib === "ME" ? who.user : lib, name: "T" } };
          const o = decide([op], who, D4).operations[0];
          reachable.add(`${role}|${o.env}|${o.decision}`);
        }
  assert.deepEqual([...reachable].filter((c) => !seen.has(c)).sort(), []);
});

test("Regression: a mutated policy fails the named case, naming the rule that now matches", async () => {
  const p = parsePolicy(readFileSync(EXAMPLE, "utf8").replace("{ env: blocked, decision: deny }", "{ env: blocked, decision: allow }"), EXAMPLE);
  const failed = (await runPolicyTests(p, loadPolicyTests(EXAMPLE_TESTS))).filter((r) => !r.ok);
  assert.deepEqual(failed.map((r) => r.name), ["analyst blocked", "contractor blocked", "dev blocked", "qa blocked"]);
  assert.match(describeFailure(failed[0]), /^FAIL analyst blocked: expected deny, got allow\n  statement 1: SELECT \* FROM PAYLIB\.T\n    allow by rule 2 .*\n    - rule 2 allows read PAYLIB\.T \(environment blocked, partition dev\)$/);
});

test("policy tests: lookup keys match in any case", async () => {
  const [r] = await runPolicyTests(
    D4,
    parsePolicyTests(
      "- name: lower\n  as: { user: JDOE, groups: [GRPDEV], partition: dev }\n  script: DELETE FROM QTEMP.A; DELETE FROM ORDER_HISTORY.T\n  lookups: { bases: { qtemp.a: [LVORD.ORDERS] }, schemas: { order_history: DVORD } }\n  expect: [deny, allow]\n",
      "t.yaml",
    ),
  );
  assert.equal(r.ok, true, describeFailure(r));
});

test("policy tests: per-statement expects, lookups, curlib; bad files are refused", async () => {
  const cases = parsePolicyTests(
    `- name: alias
  as: { user: JDOE, groups: [GRPDEV], partition: dev, curlib: LVORD }
  script: "DELETE FROM QTEMP.A;\\nCL: CLRPFM FILE(*CURLIB/X)"
  lookups: { bases: { QTEMP.A: [DVORD.T] } }
  expect: [allow, deny]
- name: count
  as: { user: JDOE, partition: dev }
  script: SELECT * FROM A.T
  expect: [allow, allow]
`,
    "t.yaml",
  );
  const [alias, count] = await runPolicyTests(D4, cases);
  assert.equal(alias.ok, true, describeFailure(alias));
  assert.equal(count.ok, false, "one statement, two expects");
  assert.throws(() => parsePolicyTests("- { name: v, as: { user: X }, script: S, verb: deploy, expect: allow }\n", "t.yaml"), /t\.yaml: 0: give exactly one of script, verb/);
  assert.throws(() => parsePolicyTests("- { name: v, as: { user: X }, script: S, args: { a: 1 }, expect: allow }\n", "t.yaml"), /t\.yaml: 0: args go with verb/);
  await assert.rejects(runPolicyTests(D4, parsePolicyTests("- { name: v, as: { user: X }, verb: deploy, expect: allow }\n", "t.yaml")), /case "v": no verbs were loaded/);
  assert.throws(() => parsePolicyTests("- { name: x, as: { user: X }, script: S, expect: alow }\n", "t.yaml"), /t\.yaml: 0\.expect/);
  assert.throws(() => parsePolicyTests("- { name: x, as: { user: X, group: [G] }, script: S, expect: allow }\n", "t.yaml"), /Unrecognized key/);
  assert.throws(() => parsePolicyTests("[]\n", "t.yaml"), /t\.yaml/);
  // an explicit tag that builds a Set, Date or Buffer passed zod 4's object check as {}; plain tags stay
  const lk = (v: string) => `- { name: x, as: { user: X }, script: S, lookups: ${v}, expect: allow }\n`;
  for (const [tag, v] of [["!!set", "!!set {}"], ["!!timestamp", "!!timestamp 2020-01-01"], ["!!binary", "!!binary aGVsbG8="], ["!!omap", "!!omap []"]])
    assert.throws(() => parsePolicyTests(lk(v), "t.yaml"), new RegExp(`^Error: t\\.yaml line 1: the YAML tag ${tag} is not allowed$`), v);
  assert.deepEqual(parsePolicyTests(lk("!!map {}"), "t.yaml")[0].lookups, {});
  assert.deepEqual(parsePolicyTests("- { name: !!str x, as: { user: X }, script: S, expect: allow }\n", "t.yaml")[0].name, "x");
  // a bare ! forces a string, as on zod 3; an unknown tag, which yaml only warns about, is refused
  assert.deepEqual(parsePolicyTests("- { name: ! 5, as: { user: X }, script: S, expect: allow }\n", "t.yaml")[0].name, "5");
  assert.throws(() => parsePolicyTests("- { name: !foo x, as: { user: X }, script: S, expect: allow }\n", "t.yaml"), /^Error: t\.yaml line 1: the YAML tag !foo is not allowed$/);
  await assert.rejects(runPolicyTests(D4, parsePolicyTests("- { name: typo, as: { user: X, partition: prd }, script: SELECT 1 FROM A.T, expect: allow }\n", "t.yaml")), /case "typo": IBMI_PARTITION prd is not a partition/);
});

// --- replay (policy-testing spec; task 3.2) ---

// A fixture run log written the way the server writes it: under the D4 example (observe on dev and
// qa, enforce on prod), with recorded lookups.
async function fixtureLog(): Promise<RunLogLine[]> {
  const calls: [string, Identity, Stub?][] = [
    ["DELETE FROM INORD.T", as("dev", "dev")], // allow by rule 6
    ["DELETE FROM DVORD.T", as("dev", "dev")], // allow by rule 6
    ["DELETE FROM LVORD.T", as("analyst", "dev")], // deny, observed
    ["DELETE FROM LVORD.T", as("analyst", "prod")], // deny, enforced
    ["CREATE ALIAS QTEMP.A FOR LVORD.ORDERS; DELETE FROM QTEMP.A", as("dev", "dev")], // the delete writes LVORD.ORDERS: deny, observed
    ["SELECT * FROM QTORD.T", as("qa", "qa")], // allow by rule 8
    ["CL: CHGUSRPRF USRPRF(X) PASSWORD(SECRET1)", as("dev", "dev")], // danger
    ["CL: CRTBNDRPG PGM(INORD/P)", as("dev", "dev")], // allow by rule 6
    ["DELETE FROM QTEMP.B", as("dev", "dev"), { bases: { "QTEMP.B": [{ lib: "INORD", name: "T" }] } }], // allow: QTEMP and INORD
  ];
  const lines: RunLogLine[] = [];
  for (const [script, who, stub] of calls) {
    const { lookups: rec, answers } = recordLookups(lookups(stub));
    const c = await classify(script, { ...d4ctx(), lookups: rec });
    const statements = c.statements.map((s) => ({ statement: s, decision: decide(s.operations, who, D4), outcome: "ok" }));
    lines.push(...runLogLines({ server: "dev1", tool: "run_script", identity: who, lookups: answers, statements }, D4));
  }
  // Through JSON, as replay reads it.
  return JSON.parse(JSON.stringify(lines)) as RunLogLine[];
}

test("replay: the same policy changes nothing (lookups and script state are replayed)", async () => {
  const log = await fixtureLog();
  const r = await replayRunLog(D4, log);
  assert.deepEqual([r.statements, r.changes, r.skipped], [log.length, [], []]);
});

test("Before enforcing: a stricter candidate lists exactly the statements whose decision changes", async () => {
  // Enforce everywhere and take integ away from dev and qa.
  const strict = parsePolicy(
    readFileSync(EXAMPLE, "utf8")
      .replace("mode: { default: observe, prod: enforce }", "mode: enforce")
      .replace("{ roles: [dev, qa], partition: dev, env: [personal, devlibs, integ], decision: allow }", "{ roles: [dev, qa], partition: dev, env: [personal, devlibs], decision: allow }"),
    EXAMPLE,
  );
  const r = await replayRunLog(strict, await fixtureLog());
  assert.deepEqual(
    r.changes.map((c) => [c.line.text, c.line.identity.partition, `${c.before.decision}/${c.before.effective}/${c.before.rule ?? "-"}`, `${c.after.decision}/${c.after.effective}/${c.after.rule ?? "-"}`]),
    [
      ["DELETE FROM INORD.T", "dev", "allow/allow/6", "deny/deny/-"],
      ["DELETE FROM LVORD.T", "dev", "deny/allow/-", "deny/deny/-"],
      ["DELETE FROM QTEMP.A", "dev", "deny/allow/-", "deny/deny/-"],
      ["CRTBNDRPG PGM(INORD/P)", "dev", "allow/allow/6", "deny/deny/-"],
      ["DELETE FROM QTEMP.B", "dev", "allow/allow/3", "deny/deny/-"],
    ],
  );
});

test("replay: a tool line's logged operations are decided again without classify, beside the call's text lines", async () => {
  const who = as("dev", "dev");
  const raw: Operation[] = [{ class: "write", object: { lib: "INORD", name: "QRPGLESRC" }, source: "sql" }];
  const tool: ToolStatement = { kind: "tool", text: "upload_source_member INORD/QRPGLESRC(ORDVAL)", display: "upload_source_member INORD/QRPGLESRC(ORDVAL)", operations: raw };
  const c = await classify("SELECT * FROM INORD.T", { ...d4ctx(), lookups: lookups() });
  const statements = [tool, ...c.statements].map((s) => ({ statement: s, decision: decide(s.operations, who, D4), outcome: "ok" }));
  const lines = JSON.parse(JSON.stringify(runLogLines({ server: "dev1", tool: "compile_member", identity: who, lookups: {}, statements }, D4))) as RunLogLine[];
  assert.deepEqual([lines[0].kind, lines[0].raw, lines[1].kind, lines[1].raw], ["tool", raw, "sql", undefined]);
  assert.deepEqual(await replayRunLog(D4, lines), { statements: 2, changes: [], skipped: [] });
  const strict = parsePolicy(readFileSync(EXAMPLE, "utf8").replace("partition: dev, env: [personal, devlibs, integ]", "partition: dev, env: [personal, devlibs]"), EXAMPLE);
  const r = await replayRunLog(strict, lines);
  assert.deepEqual(r.changes.map((x) => [x.line.text, x.before.decision, x.after.decision]), [["upload_source_member INORD/QRPGLESRC(ORDVAL)", "allow", "deny"]], "the read stays allowed by the read rule");
  const noOps = await replayRunLog(D4, [{ ...lines[0], raw: undefined }]);
  assert.match(noOps.skipped[0] ?? "", /line 0 is a tool line without its operations/);
});

test("replay: a log line whose text no longer splits the same is skipped and named", async () => {
  const [line] = await fixtureLog();
  const r = await replayRunLog(D4, [{ ...line, text: "SELECT 1 FROM A.T; SELECT 2 FROM A.T" }]);
  assert.deepEqual([r.statements, r.changes.length], [0, 0]);
  assert.match(r.skipped[0], /splits into 2 statements, not 1/);
});

test("replay: lookups and notes are written once per call, on its first line, and read from there", async () => {
  const c = await call("DELETE FROM QTEMP.B; SELECT * FROM QTEMP.B", as("dev", "dev"));
  c.lookups = { bases: { "QTEMP.B": ["INORD.T"], "INORD.T": [] } };
  c.notes = ["a note"];
  const lines = runLogLines(c, D4);
  assert.deepEqual([lines[0].lookups, lines[0].notes, lines[1].lookups, lines[1].notes], [{ bases: { "QTEMP.B": ["INORD.T"], "INORD.T": [] } }, ["a note"], undefined, undefined]);
  const strict = parsePolicy(readFileSync(EXAMPLE, "utf8").replace("partition: dev, env: [personal, devlibs, integ]", "partition: dev, env: [personal, devlibs]"), EXAMPLE);
  const r = await replayRunLog(strict, [lines[1], lines[0]]);
  assert.deepEqual(r.changes.map((x) => [x.line.index, x.after.decision]), [[0, "deny"]], "the base table from line 0's answers decides");
  const partial = await replayRunLog(D4, [lines[1]]);
  assert.match(partial.skipped[0] ?? "", /its statements in the log are 1, not 0 to 0: a line is missing/);
});

test("replay: a call whose lookups are malformed is skipped with the reason", async () => {
  const [line] = await fixtureLog();
  const r = await replayRunLog(D4, [{ ...line, lookups: { bases: { "QTEMP.A": "LVORD.ORDERS" } } as unknown as RunLogLine["lookups"] }]);
  assert.deepEqual([r.statements, r.changes.length], [0, 0]);
  assert.match(r.skipped[0] ?? "", /^call .*: lookups: bases\.QTEMP\.A: Invalid input: expected array, received string/);
});

test("replay: a __proto__ key in recorded lookups (JSON) is still refused, the line skipped with the reason", async () => {
  // the lookups object is strict, so zod 4 reports the own key as unrecognized before it could drop it
  const [line] = await fixtureLog();
  const lookups = { ...line.lookups };
  Object.defineProperty(lookups, "__proto__", { value: { x: 1 }, enumerable: true, configurable: true, writable: true }); // an own key, as JSON.parse makes
  const r = await replayRunLog(D4, [{ ...line, lookups }]);
  assert.deepEqual([r.statements, r.changes.length], [0, 0]);
  assert.match(r.skipped[0] ?? "", /lookups: \(top\): Unrecognized key: "__proto__"/);
});

test("replay: a candidate that looks up what the live run never asked is skipped, not decided on guesses", async () => {
  // Live, CMCHK was an unknown command: no object, no lookup. The candidate's command file makes
  // FILE(QTEMP/A) an object, whose base tables nobody recorded.
  const [line] = await (async () => {
    const { lookups: rec, answers } = recordLookups(lookups());
    const c = await classify("CL: CMCHK FILE(QTEMP/A)", { ...d4ctx(), lookups: rec });
    const who = as("dev", "dev");
    return runLogLines({ server: "dev1", tool: "run_script", identity: who, lookups: answers, statements: c.statements.map((s) => ({ statement: s, decision: decide(s.operations, who, D4), outcome: "ok" })) }, D4);
  })();
  assert.deepEqual([line.decision, line.operations[0].reason], ["deny", "unknown_command"]);
  const dir = tmp();
  writeFileSync(join(dir, "cm-product.yaml"), readFileSync(join(dirname(EXAMPLE), "cm-product.yaml"), "utf8"));
  writeFileSync(join(dir, "cmchk.yaml"), "commands:\n  CMCHK: { class: write, params: { FILE: object } }\n");
  writeFileSync(join(dir, "policy.yaml"), readFileSync(EXAMPLE, "utf8").replace("command_files: [cm-product.yaml]", "command_files: [cm-product.yaml, cmchk.yaml]"));
  const r = await replayRunLog(loadPolicy(join(dir, "policy.yaml")), [line]);
  assert.deepEqual([r.statements, r.changes.length], [0, 0], "not reported as allow");
  assert.match(r.skipped[0] ?? "", /the candidate looks up the base tables of QTEMP\.A, which the logged run never did/);
});

test("replay: a malformed identity or names line, and a call missing a line, are skipped with the reason", async () => {
  const bad = { ...(await builtinLine({ system: "DEVBOX" })), names: { system: 5 } } as unknown as RunLogLine;
  const r = await replayRunLog(D4, [bad]);
  assert.deepEqual([r.statements, r.changes.length, r.skipped.length], [0, 0, 1]);
  const c = await call("SELECT * FROM LVORD.T; SELECT * FROM DVORD.T; SELECT * FROM INORD.T", as("dev", "dev"));
  const three = runLogLines(c, D4);
  const gap = await replayRunLog(D4, [three[0], three[2]]);
  assert.deepEqual([gap.statements, gap.changes.length], [0, 0]);
  assert.match(gap.skipped[0] ?? "", /its statements in the log are 0, 2, not 0 to 1: a line is missing/);
});

async function builtinLine(names?: { system?: string; rdb?: string; declared?: string }, partition?: string): Promise<RunLogLine> {
  const p = builtinPolicy();
  const who: Identity = { user: "JDOE", groups: ["GRPDEV"], authlists: [], ...(partition ? { partition } : {}) };
  const { lookups: rec, answers } = recordLookups(statedLookups());
  const c = await classify("DELETE FROM DVORD.T", { lookups: rec, commands: p.commands, rdbs: p.rdbs });
  const statements = c.statements.map((s) => ({ statement: s, decision: decide(s.operations, who, p), outcome: "ok" }));
  const [line] = runLogLines({ server: "dev1", tool: "run_script", identity: who, lookups: answers, statements, ...(names ? { names } : {}) }, p);
  return JSON.parse(JSON.stringify(line)) as RunLogLine;
}

test("replay: the candidate detects the partition again from the logged System and RDB names", async () => {
  const line = await builtinLine({ system: "DEVBOX" });
  assert.deepEqual([line.names, line.decision, line.effective], [{ system: "DEVBOX" }, "allow", "allow"]);
  const r = await replayRunLog(D4, [line]);
  assert.deepEqual([r.statements, r.changes, r.skipped], [1, [], []], "DEVBOX is dev under the example: rule 6 allows");
  const noNames = await replayRunLog(D4, [await builtinLine()]);
  assert.equal(noNames.changes[0]?.after.decision, "deny", "without names the example's unknown_partition (prod) decides");
  const conflict = await replayRunLog(D4, [await builtinLine({ system: "DEVBOX", rdb: "PRODRDB" })]);
  assert.deepEqual([conflict.changes[0]?.after.decision, conflict.changes[0]?.after.effective], ["deny", "deny"], "names the candidate maps apart conflict");
});

test("replay: a logged partition the candidate does not define is skipped with a reason", async () => {
  const r = await replayRunLog(D4, [await builtinLine(undefined, "test")]);
  assert.deepEqual([r.statements, r.changes.length], [0, 0]);
  assert.match(r.skipped[0], /logged partition test is not a partition of the candidate/);
});

test("replay: a call the profile password was scrubbed from is skipped with that reason", async () => {
  const c = await call("SELECT * FROM LVORD.T WHERE C = 'hunter2'", as("dev", "dev"), { secret: "hunter2" });
  const r = await replayRunLog(D4, runLogLines(c, D4));
  assert.deepEqual([r.statements, r.changes.length], [0, 0]);
  assert.match(r.skipped[0], /profile password was taken out of it/);
});

// --- undeclared CL parameters are flagged (statement-classification; policy-param-warn 1.4) ---

const XYZ: CommandTable = { XYZCPY: { class: "write", positional: ["FROMOBJ"], params: { FROMOBJ: "object" } } };
const xyzCtx = (table: CommandTable = XYZ): ClassifyContext => ({ lookups: lookups(), commands: mergeCommands(builtinCommands(), table) });
const WARN = /^XYZCPY TOLIB\(\): the command table does not declare this parameter, so a library or object it names is not decided$/;

test("param warning: an undeclared keyword that names a library warns, naming command and keyword only", async () => {
  const c = await classify("CL: XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)", xyzCtx());
  assert.equal(c.statements[0].warnings?.length, 1);
  assert.match(c.statements[0].warnings![0], WARN);
  assert.ok(!c.statements[0].warnings![0].includes("PRODLIB"), "the value never reaches the warning");
  assert.deepEqual(c.notes, c.statements[0].warnings, "the run log gets it as a note");
});

test("param warning: *LIBL/OUT still names an object, so it warns", async () => {
  const c = await classify("CL: XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(*LIBL/OUT)", xyzCtx());
  assert.match(c.statements[0].warnings?.[0] ?? "", WARN);
});

test("param warning: declared keywords and values that name nothing stay silent", async () => {
  for (const script of [
    "CL: DSPOBJD OBJ(A/*ALL) OBJTYPE(*FILE) OUTPUT(*OUTFILE) OUTFILE(B/OUT)",
    "CL: CRTBNDRPG PGM(APPLIB/ORD) SRCFILE(APPLIB/QRPGLESRC) DBGVIEW(*SOURCE) TEXT('Orders')",
    "CL: XYZCPY FROMOBJ(APPLIB/ORD) COUNT(5) MODE(*REPLACE) NOTE('x y')",
    "CL: XYZCPY APPLIB/ORD",
  ]) {
    const c = await classify(script, xyzCtx());
    assert.equal(c.statements[0].warnings, undefined, script);
    assert.deepEqual(c.notes, [], script);
  }
});

test("param warning: class_by_param and nested_sql keywords count as declared", async () => {
  const ctx = xyzCtx({ ...CM, XYZSQL: { class: "read", nested_sql: "STMT" } });
  assert.equal((await classify("CL: CMPRM REQ(1234) LEVEL(QA)", ctx)).statements[0].warnings, undefined);
  assert.equal((await classify("CL: XYZSQL STMT('SELECT * FROM A.T')", ctx)).statements[0].warnings, undefined);
  assert.match((await classify("CL: CMPRM REQ(1234) LEVEL(QA) TOLIB(PRODLIB)", ctx)).statements[0].warnings?.[0] ?? "", /^CMPRM TOLIB\(\):/);
});

test("param warning: the warning never changes an operation or a decision", async () => {
  const withKw = await classify("CL: XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)", xyzCtx());
  const without = await classify("CL: XYZCPY FROMOBJ(APPLIB/ORD)", xyzCtx());
  assert.equal(withKw.statements[0].warnings?.length, 1);
  assert.equal(without.statements[0].warnings, undefined);
  assert.deepEqual(withKw.operations, without.operations);
  assert.deepEqual(sorted(withKw.operations), ["write APPLIB.ORD"]);
  for (const who of ["dev", "qa", "contractor"]) {
    assert.deepEqual(decide(withKw.operations, as(who, "dev"), D4), decide(without.operations, as(who, "dev"), D4), who);
  }
});

test("param warning: a table that declares the keyword silences it, and the library is decided", async () => {
  const declared: CommandTable = { XYZCPY: { ...XYZ.XYZCPY, params: { FROMOBJ: "object", TOLIB: "library" } } };
  const c = await classify("CL: XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)", xyzCtx(declared));
  assert.equal(c.statements[0].warnings, undefined);
  assert.deepEqual(sorted(c.operations), ["write APPLIB.ORD", "write lib PRODLIB"]);
});

test("param warning: CL inside QCMDEXC warns on the SQL statement; each statement keeps its own", async () => {
  const c = await classify("VALUES QSYS2.QCMDEXC('XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)');\nCL: XYZCPY FROMOBJ(APPLIB/ORD)\nCL: XYZCPY FROMOBJ(APPLIB/ORD) TOLIB(PRODLIB)", xyzCtx());
  assert.deepEqual(c.statements.map((s) => s.warnings?.length ?? 0), [1, 0, 1]);
  assert.match(c.statements[0].warnings![0], WARN);
  assert.equal(c.notes.length, 2);
});

test("param warning: an unknown command and a danger command never warn", async () => {
  for (const script of ["CL: FROBCMD X TOLIB(PRODLIB)", "CL: PWRDWNSYS OPTION(*IMMED) TOLIB(PRODLIB)"]) {
    const c = await classify(script, xyzCtx());
    assert.equal(c.statements[0].operations[0].class, "danger", script);
    assert.equal(c.statements[0].warnings, undefined, script);
    assert.deepEqual(c.notes, [], script);
  }
});
