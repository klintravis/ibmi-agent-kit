// Table-driven checks for the classifier. One row per scenario in
// openspec/changes/execution-guard/specs/statement-classification/spec.md (named after it), then
// the bypasses from the design reviews, then the rest of the surface. No live IBM i: lookups are
// stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import { bindArgs, loadVerbs, resolveVerb, substitute, type VerbParam, type VerbSources } from "./index.js";
import {
  builtinCommands,
  classify,
  classifyCl,
  builtinPolicy,
  customClasses,
  decide,
  detectPartition,
  environmentOf,
  loadPolicy,
  mergeCommands,
  parsePolicy,
  rolesOf,
  parseCommandFile,
  splitScript,
  type Classification,
  type ClassifyContext,
  type CommandTable,
  type Identity,
  type Lookups,
  type Operation,
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
    name: "a failed lookup keeps the object's own class and is noted",
    script: "DELETE FROM LIVLIB.V",
    stub: { basesThrow: true },
    ops: ["write LIVLIB.V"],
    check: (r) => assert.match(r.notes.join("\n"), /LIVLIB\.V failed/),
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
  { name: "a parameter naming another (*FROMLIB)", script: "CL: CRTDUPOBJ OBJ(X) FROMLIB(A) OBJTYPE(*FILE) TOLIB(*FROMLIB) NEWOBJ(Y)", ops: ["ddl lib A", "read lib A"] },
  { name: "copy reads one file and writes another", script: "CL: CPYF FROMFILE(LIVLIB/ORD) TOFILE(JDOE/ORD) MBROPT(*REPLACE)", ops: ["read LIVLIB.ORD", "write JDOE.ORD"] },
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
  assert.ok(set.errors[0].split("\n").includes(`${join(root, P, "BAD.yaml")}: (top): Unrecognized key(s) in object: 'step'`), set.errors[0]);
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
    ["steps: []\n", /steps: Array must contain at least 1/],
    ["steps:\n  - { sql: VALUES 1, cl: DSPLIB }\n", /steps\.0: give exactly one of sql, cl, expect, verb/],
    ["steps:\n  - { sql: VALUES 1, args: { a: 1 } }\n", /steps\.0: args go with verb/],
    ["steps:\n  - { sql: VALUES 1, requires_absent: VALUES 1 }\n", /steps\.0: Unrecognized key\(s\) in object: 'requires_absent'/],
    ["steps:\n  - expect: { sql: VALUES 1, rows: 1, empty: true }\n", /steps\.0\.expect: give exactly one of equals, rows, empty/],
    ["setup:\n  - { id: s, sql: VALUES 1 }\n  - { id: s, sql: VALUES 2 }\nsteps:\n  - sql: VALUES 1\n", /setup\.1\.id: s is used twice/],
    ["steps:\n  - sql: VALUES 1\ncleanup:\n  - { undoes: seed, sql: VALUES 1 }\n", /cleanup\.0\.undoes: no setup step has id seed/],
    ["steps:\n  - sql: VALUES 1\ncleanup:\n  - { sql: VALUES 1 }\n", /cleanup\.0\.undoes: Required/],
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
});

test("verbs: injection: x' or '1'='1 arrives as a bound value with the statement text unchanged", () => {
  const params: Record<string, VerbParam> = { name: { type: "string" } };
  const values = bindArgs({ address: "proj:X", params }, { name: "x' or '1'='1" });
  const sql = `SELECT * FROM T WHERE A = :name AND B = ':name' AND "C:name" = 1 -- :name\nAND D = 1 /* :name */`;
  assert.deepEqual(substitute(sql, "sql", params, values), {
    text: `SELECT * FROM T WHERE A = ? AND B = ':name' AND "C:name" = 1 -- :name\nAND D = 1 /* :name */`,
    params: ["x' or '1'='1"],
  });
});

test("verbs: typed values are validated, and what is not one is refused", () => {
  const p = (type: VerbParam["type"]) => ({ address: "proj:X", params: { v: { type } as VerbParam } });
  const bad = [["integer", "1 OR 1=1"], ["integer", 1.5], ["integer", "9007199254740993"], ["integer", Infinity], ["decimal", "1;DROP"], ["decimal", NaN], ["decimal", Infinity], ["decimal", 1e21], ["decimal", "1e5"], ["date", "2026-01-01' OR"], ["date", "2026-02-30"], ["date", 20260101], ["boolean", "true"], ["boolean", 1], ["string", 42]] as const;
  for (const [type, v] of bad) assert.throws(() => bindArgs(p(type), { v }), /^Error: proj:X: v: .+ is not /, `${type} ${String(v)}`);
  const good = [["integer", "007", 7], ["integer", -3, -3], ["decimal", "12.50", "12.50"], ["decimal", -0.5, "-0.5"], ["date", "2024-02-29", "2024-02-29"], ["boolean", false, false], ["string", "", ""]] as const;
  for (const [type, v, want] of good) assert.deepEqual(bindArgs(p(type), { v }), { v: want }, `${type} ${String(v)}`);
  assert.throws(() => bindArgs(p("integer")), /v has no value and no default/);
  assert.throws(() => bindArgs(p("integer"), { v: 1, w: 2 }), /w is not a parameter/);
  assert.throws(() => bindArgs(p("integer"), { constructor: 1, v: 1 }), /constructor is not a parameter/);
  assert.equal(substitute("VALUES ${b}", "sql", { b: { type: "boolean" } }, { b: true }).text, "VALUES TRUE");
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
    ["n: { type: decimal, default: .inf }", 'sql: "VALUES :n"', /params\.n\.default: Infinity is not a decimal number/],
    ["n: { type: integer, allowed: [1, two] }", 'sql: "VALUES :n"', /params\.n\.allowed\.1: "two" is not an integer/],
    ["s: { type: string, allowed: [01] }", 'sql: "VALUES :s"', /params\.s\.allowed\.0: 1 is not a string/],
    ["s: { type: string }", 'verb: OTHER\n    args: { t: "${s}" }', /steps\.0\.args\.t: \$\{s\}: parameter s is a string with no allowed list/],
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
  assert.equal(substitute("VALUES 1;", "sql", n, {}).text, "VALUES 1;");
  const semi: Record<string, VerbParam> = { s: { type: "string", allowed: ["IN1; DELETE FROM T"] } };
  assert.throws(() => substitute("SELECT * FROM ORD${s}.T", "sql", semi, { s: "IN1; DELETE FROM T" }), /substituted: one SQL statement per step/);
});
