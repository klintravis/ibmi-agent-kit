// SQL classification (design D2): one pass over a statement's tokens that recognises the risky
// verbs wherever they stand (so FINAL TABLE, data-change CTEs, routine and trigger bodies and
// QCMDEXC inside a SELECT need no special case), plus a check that the statement's head is one
// the guard knows, and small recognisers that consume clause words which would otherwise
// false-trigger the pass (GRANT ... UPDATE, ALTER TABLE ... DROP COLUMN, AFTER DELETE ON).
import { BUILTINS, BUILTIN_SCHEMAS, CATALOG_TABLE_FUNCTIONS, COMMAND_RUNNERS, FROM_IN_ARGS, KEYWORDS, OPAQUE_RUNNERS } from "./builtins.js";
import type { Token } from "./lexer.js";
import { danger, objectOp, type Run } from "./run.js";
import type { ObjectRef, OpClass, Operation } from "./types.js";

const HEADS = new Set([
  "SELECT", "WITH", "VALUES", "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "CALL", "LOCK",
  "REFRESH", "CREATE", "ALTER", "DROP", "RENAME", "COMMENT", "LABEL", "GRANT", "REVOKE", "DECLARE",
  "BEGIN", "SET", "CONNECT", "DISCONNECT", "RELEASE", "COMMIT", "ROLLBACK", "SAVEPOINT", "TRANSFER",
  "EXECUTE", "PREPARE", "DESCRIBE",
]);
// Words that end a FROM clause; before one, a comma at the clause's depth starts another table.
const FROM_END = new Set([
  "WHERE", "GROUP", "HAVING", "ORDER", "UNION", "EXCEPT", "INTERSECT", "FETCH", "OFFSET", "LIMIT",
  "FOR", "WITH", "WINDOW", "INTO", "SKIP", "OPTIMIZE", "USE", "WAIT", "THEN", "ELSE", "END", "DO",
  "WHEN", "SELECT", "VALUES", "SET",
]);
const OBJECT_TYPES = new Set([
  "TABLE", "VIEW", "INDEX", "ALIAS", "PROCEDURE", "FUNCTION", "ROUTINE", "TRIGGER", "SEQUENCE",
  "TYPE", "DISTINCT", "VARIABLE", "MASK", "PERMISSION", "PACKAGE", "XSROBJECT", "SCHEMA",
  "COLLECTION", "SPECIFIC", "COLUMN", "CONSTRAINT", "PARAMETER",
]);
// SET <register> statements that change nothing an operation is decided on.
const HARMLESS_SET = new Set([
  "TRANSACTION", "ENCRYPTION", "OPTION", "RESULT", "DEGREE", "DEBUG", "DECFLOAT", "IMPLICIT",
  "LOCALE", "TEMPORAL", "LOCK", "QUERY", "TIMEZONE",
]);
const SCHEMA_REGISTERS = new Set(["SCHEMA", "CURRENT_SCHEMA", "SQLID"]);
const PATH_REGISTERS = new Set(["PATH", "CURRENT_PATH", "FUNCTION"]);
// Between FETCH and FROM c: FETCH NEXT FROM c, FETCH ABSOLUTE 5 FROM c.
const FETCH_WORDS = new Set(["NEXT", "PRIOR", "FIRST", "LAST", "BEFORE", "AFTER", "CURRENT", "ABSOLUTE", "RELATIVE"]);
// A change verb at the head that yields no operation was not understood.
const CHANGE_HEADS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "CALL", "LOCK", "REFRESH", "CREATE", "ALTER",
  "DROP", "RENAME", "COMMENT", "LABEL", "GRANT", "REVOKE", "DECLARE", "TRANSFER",
]);

const isWord = (t: Token | undefined, ...w: string[]): t is Token => t?.type === "word" && w.includes(t.upper);
const isOp = (t: Token | undefined, v: string): t is Token => t?.type === "op" && t.value === v;
const isNamePart = (t: Token | undefined): t is Token => t?.type === "word" || t?.type === "delim";

interface Name {
  parts: string[];
  end: number; // index of the last token of the name
}

// One- to n-part name in SQL (A.B) or system (A/B) naming. Delimited names are normalised to upper
// case: matching is case-insensitive, so "Livlib" and LIVLIB land in the same environment.
function readName(t: Token[], i: number): Name | undefined {
  if (!isNamePart(t[i])) return undefined;
  const parts = [t[i].upper];
  let end = i;
  while ((isOp(t[end + 1], ".") || isOp(t[end + 1], "/")) && isNamePart(t[end + 2])) {
    parts.push(t[end + 2].upper);
    end += 2;
  }
  return { parts, end };
}

function matchParen(t: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < t.length; k++) {
    if (isOp(t[k], "(")) depth++;
    else if (isOp(t[k], ")") && --depth === 0) return k;
  }
  return -1;
}

class Scan {
  ops: Operation[] = [];
  private skip = new Set<number>();
  private locals = new Set<string>(); // CTE and transition-table names: not objects
  private tableFns = new Set<number>(); // token index of a function written as FROM TABLE(fn(...))
  createdView?: string[];

  constructor(private t: Token[], private run: Run) {
    this.collectLocals();
  }

  // --- operations ---
  private object(parts: string[]): ObjectRef | undefined {
    if (parts.length > 3) return undefined;
    const [rdb, lib, name] = parts.length === 3 ? parts : parts.length === 2 ? [undefined, ...parts] : [undefined, undefined, parts[0]];
    const o: ObjectRef = { name };
    if (rdb) o.rdb = rdb;
    if (lib) o.lib = lib === "SESSION" ? "QTEMP" : lib; // declared temporary tables live in QTEMP
    return o;
  }

  private op(cls: OpClass, parts: string[]): void {
    const o = this.object(parts);
    if (!o) { this.danger(`${parts.join(".")} has more than three parts`); return; }
    this.ops.push(objectOp(cls, o, "sql", this.run));
  }

  private lib(cls: OpClass, lib: string): void {
    this.ops.push(objectOp(cls, { lib, name: lib, type: "*LIB" }, "sql", this.run));
  }

  danger(reason: string): void {
    this.ops.push(danger("sql", reason, this.run));
  }

  private consume(n: Name): void {
    for (let k = n.end; k >= 0 && k >= n.end - 2 * (n.parts.length - 1); k--) this.skip.add(k);
  }

  // The object a verb acts on, at t[k]; danger when there is none to read.
  private target(cls: OpClass, k: number, verb: string): Name | undefined {
    const n = readName(this.t, k);
    if (!n) { this.danger(`the object ${verb} acts on is not a name the guard can read`); return undefined; }
    this.consume(n);
    this.op(cls, n.parts);
    return n;
  }

  private toEnd(from: number): void {
    for (let k = from; k < this.t.length && this.t[k].type !== "semi"; k++) this.skip.add(k);
  }

  private findWord(from: number, w: string): number {
    let depth = 0;
    for (let k = from; k < this.t.length && this.t[k].type !== "semi"; k++) {
      if (isOp(this.t[k], "(")) depth++;
      else if (isOp(this.t[k], ")")) depth--;
      else if (depth === 0 && isWord(this.t[k], w)) return k;
    }
    return -1;
  }

  // --- names that are not objects ---
  private collectLocals(): void {
    const t = this.t;
    for (let j = 0; j < t.length; j++) {
      if (isWord(t[j], "WITH")) {
        let k = j + 1;
        if (isWord(t[k], "RECURSIVE")) k++;
        for (;;) {
          if (!isNamePart(t[k]) || isOp(t[k + 1], ".")) break;
          let as = k + 1;
          if (isOp(t[as], "(")) { const e = matchParen(t, as); if (e < 0) break; as = e + 1; }
          if (!isWord(t[as], "AS") || !isOp(t[as + 1], "(")) break;
          this.locals.add(t[k].upper);
          this.skip.add(k);
          const e = matchParen(t, as + 1);
          if (e < 0 || !isOp(t[e + 1], ",")) break;
          k = e + 2;
        }
      }
      if (isWord(t[j], "REFERENCING")) {
        let k = j + 1;
        while (isWord(t[k], "OLD", "NEW")) {
          k++;
          if (isWord(t[k], "TABLE", "ROW")) k++;
          if (isWord(t[k], "AS")) k++;
          if (!isNamePart(t[k])) break;
          this.locals.add(t[k].upper);
          this.skip.add(k);
          k++;
        }
      }
    }
  }

  // --- the pass ---
  scan(): void {
    const t = this.t;
    const parens: string[] = [];
    for (let i = 0; i < t.length; i++) {
      const tok = t[i];
      if (tok.type === "op") {
        if (tok.value === "(") parens.push(t[i - 1]?.type === "word" ? t[i - 1].upper : "");
        else if (tok.value === ")") parens.pop();
        continue;
      }
      if (this.skip.has(i) || !isNamePart(tok)) continue;
      // a keyword followed by "." is a schema that happens to be called KEY, DATA, LABEL ...
      if (tok.type === "word" && !isOp(t[i + 1], ".")) {
        if (this.verb(i, parens[parens.length - 1] ?? "")) continue;
        if (KEYWORDS.has(tok.upper)) continue;
      }
      const n = readName(t, i);
      if (!n) continue;
      if (isOp(t[n.end + 1], "(")) this.call(i, n);
      i = n.end;
    }
  }

  // A verb or clause keyword at t[i]. True when it was one (handled or plain syntax).
  private verb(i: number, inFn: string): boolean {
    const t = this.t;
    const next = t[i + 1];
    // DELETE B.X without FROM, but not AFTER DELETE ON or THEN DELETE WHEN
    const plainName = (k: number) =>
      t[k]?.type === "delim" || (t[k]?.type === "word" && (!KEYWORDS.has(t[k].upper) || isOp(t[k + 1], ".") || isOp(t[k + 1], "/")));
    switch (t[i].upper) {
      case "DELETE":
        if (isWord(next, "FROM")) { this.skip.add(i + 1); this.target("write", i + 2, "DELETE"); }
        else if (plainName(i + 1)) this.target("write", i + 1, "DELETE");
        return true;
      case "INSERT":
        if (isWord(next, "INTO")) { this.skip.add(i + 1); this.target("write", i + 2, "INSERT"); }
        else if (plainName(i + 1)) this.target("write", i + 1, "INSERT");
        return true;
      case "UPDATE":
        if (isOp(next, "(")) this.danger("UPDATE of a fullselect is not classified; update the table by name");
        else if (plainName(i + 1)) this.target("write", i + 1, "UPDATE");
        return true;
      case "MERGE": {
        if (!isWord(next, "INTO")) { this.danger("MERGE without INTO is not classified"); return true; }
        this.skip.add(i + 1);
        const n = this.target("write", i + 2, "MERGE");
        const using = n ? this.findWord(n.end + 1, "USING") : -1;
        if (using >= 0) {
          this.skip.add(using);
          const src = readName(t, using + 1);
          if (src && !isOp(t[src.end + 1], "(") && !this.locals.has(src.parts.join("."))) { this.consume(src); this.op("read", src.parts); }
        }
        return true;
      }
      case "TRUNCATE":
        if (isOp(next, "(")) return true; // the TRUNCATE() scalar function
        this.target("write", isWord(next, "TABLE") ? i + 2 : i + 1, "TRUNCATE");
        return true;
      case "LOCK":
      case "REFRESH":
        if (isWord(next, "TABLE")) this.target("write", i + 2, t[i].upper);
        return true;
      case "FROM":
      case "JOIN":
        if (t[i].upper === "FROM" && (FROM_IN_ARGS.has(inFn) || isWord(t[i - 1], "DISTINCT") || this.afterFetch(i))) return true;
        if (t[i].upper === "FROM") this.fromList(i + 1);
        else this.ref(i + 1);
        return true;
      case "REFERENCES":
        this.target("read", i + 1, "REFERENCES");
        return true;
      case "CALL": {
        const n = readName(t, i + 1);
        if (!n) { this.danger("the procedure CALL runs is not a name the guard can read"); return true; }
        this.consume(n);
        this.callTarget(n);
        return true;
      }
      case "NEXT":
      case "PREVIOUS":
        if (isWord(next, "VALUE") && isWord(t[i + 2], "FOR")) this.target(t[i].upper === "NEXT" ? "write" : "read", i + 3, "a sequence reference");
        return true;
      case "EXECUTE":
      case "PREPARE":
      case "DESCRIBE":
        this.danger(`${t[i].upper} runs SQL built at run time, which the guard cannot see`);
        return true;
      case "CONNECT":
      case "DISCONNECT":
        this.danger(`${t[i].upper} inside a statement is not classified`);
        return true;
      case "SET":
        if (isWord(next, "CONNECTION")) this.danger("SET CONNECTION inside a statement is not classified");
        else if (isWord(next, "SESSION", "SESSION_USER")) this.danger("changing the session user is not classified");
        return true;
      case "RELEASE":
        if (!isWord(next, "SAVEPOINT", "TO")) this.danger("RELEASE of a connection inside a statement is not classified");
        return true;
      case "CREATE": this.create(i); return true;
      case "ALTER": this.alter(i); return true;
      case "DROP": this.drop(i); return true;
      case "RENAME": {
        this.skip.add(i);
        this.target("ddl", isWord(next, "TABLE", "INDEX") ? i + 2 : i + 1, "RENAME");
        this.toEnd(i);
        return true;
      }
      case "GRANT":
      case "REVOKE": this.grant(i); return true;
      case "TRANSFER": this.transfer(i); return true;
      case "COMMENT":
      case "LABEL":
        if (!isWord(next, "ON")) return t[i].upper === "LABEL";
        this.commentOn(i);
        return true;
      case "DECLARE":
        if (isWord(next, "GLOBAL")) this.dgtt(i);
        return true;
      default:
        return false;
    }
  }

  private afterFetch(i: number): boolean {
    const t = this.t;
    let j = i - 1;
    while (j >= i - 4 && (t[j]?.type === "number" || isOp(t[j], "-") || (t[j]?.type === "word" && FETCH_WORDS.has(t[j].upper)))) j--;
    return isWord(t[j], "FETCH");
  }

  // The table references of a FROM clause: the first, then one after each comma at the clause's
  // own depth (FROM A.T JOIN A.U ON ..., A.W), up to the word that ends the clause.
  private fromList(k: number): void {
    const t = this.t;
    let next = this.ref(k);
    if (next < 0) return;
    let depth = 0;
    for (let x = next; x < t.length && t[x].type !== "semi"; x++) {
      if (isOp(t[x], "(")) depth++;
      else if (isOp(t[x], ")")) { if (--depth < 0) return; }
      else if (depth === 0 && isWord(t[x], ...FROM_END)) return;
      else if (depth === 0 && isOp(t[x], ",")) {
        next = this.ref(x + 1);
        if (next < 0) return;
        x = next - 1;
      }
    }
  }

  // One table reference at t[k]; returns the index after it and its correlation name, or -1.
  private ref(k: number): number {
    const t = this.t;
    const x = t[k];
    if (!x) return -1;
    if (isWord(x, "LATERAL")) return this.ref(k + 1);
    if (isOp(x, "(")) {
      const e = matchParen(t, k); // a subquery: the pass classifies its inside
      return e < 0 ? -1 : this.corr(e + 1);
    }
    if (isWord(x, "TABLE") && isOp(t[k + 1], "(")) {
      this.tableFns.add(k + 2);
      const e = matchParen(t, k + 1);
      return e < 0 ? -1 : this.corr(e + 1);
    }
    if (isWord(x, "FINAL", "NEW", "OLD") && isWord(t[k + 1], "TABLE") && isOp(t[k + 2], "(")) {
      const e = matchParen(t, k + 2); // the data change inside is found by the pass
      return e < 0 ? -1 : this.corr(e + 1);
    }
    if (!isNamePart(x)) return -1;
    const n = readName(t, k)!;
    if (isOp(t[n.end + 1], "(")) {
      if (n.parts.length > 1 || !BUILTINS.has(n.parts[0])) return -1; // a function: the call check decides it
      const e = matchParen(t, n.end + 1); // XMLTABLE, JSON_TABLE, UNNEST
      return e < 0 ? -1 : this.corr(e + 1);
    }
    this.consume(n);
    if (!(n.parts.length === 1 && this.locals.has(n.parts[0]))) this.op("read", n.parts);
    return this.corr(n.end + 1);
  }

  // An optional correlation name and column list after a table reference; returns what follows.
  private corr(k: number): number {
    const t = this.t;
    let named = false;
    if (isWord(t[k], "AS") && isNamePart(t[k + 1])) { this.skip.add(k + 1); k += 2; named = true; }
    else if (t[k]?.type === "delim" || (t[k]?.type === "word" && !KEYWORDS.has(t[k].upper))) { this.skip.add(k); k++; named = true; }
    if (named && isOp(t[k], "(")) { const e = matchParen(t, k); if (e > 0) k = e + 1; }
    return k;
  }

  // A function call at t[i] (name n, followed by "(").
  private call(i: number, n: Name): void {
    const parts = n.parts;
    const last = parts[parts.length - 1];
    if (parts.length === 1 && BUILTINS.has(last)) return;
    if (parts.length === 2 && BUILTIN_SCHEMAS.has(parts[0]) && BUILTINS.has(last)) return;
    if (parts.length === 2 && this.tableFns.has(i) && CATALOG_TABLE_FUNCTIONS[parts[0]]?.has(last)) {
      this.op("read", parts);
      return;
    }
    this.callTarget(n);
  }

  // A routine about to run: QCMDEXC classifies its command, QCAPCMD is danger, anything else is a call.
  private callTarget(n: Name): void {
    const parts = n.parts;
    const last = parts[parts.length - 1];
    const ibm = parts.length === 1 || (parts.length === 2 && (parts[0] === "QSYS" || parts[0] === "QSYS2"));
    if (COMMAND_RUNNERS.has(last) && ibm) { this.qcmdexc(n.end + 1); return; }
    if (OPAQUE_RUNNERS.has(last)) { this.danger(`${last} runs a command or shell the guard does not see`); return; }
    this.op("call", parts);
  }

  // QCMDEXC('command' [, length]): exactly one string literal, classified as the CL it runs.
  private qcmdexc(open: number): void {
    const t = this.t;
    if (!isOp(t[open], "(")) { this.danger("QCMDEXC without a literal command"); return; }
    let k = open + 1;
    if (t[k]?.type === "word" && isOp(t[k + 1], "=>")) k += 2; // named argument
    const s = t[k];
    k++;
    if (isOp(t[k], ",") && t[k + 1]?.type === "number") k += 2;
    if (s?.type !== "string" || !isOp(t[k], ")")) {
      this.danger("QCMDEXC with a command built at run time: pass one string literal so the command can be decided");
      return;
    }
    this.skip.add(k - 1);
    this.ops.push(...this.run.nestedCl(s.value, "QCMDEXC"));
  }

  // --- DDL recognisers ---
  private create(i: number): void {
    const t = this.t;
    let k = i + 1;
    if (isWord(t[k], "OR") && isWord(t[k + 1], "REPLACE")) k += 2;
    const w = t[k]?.type === "word" ? t[k].upper : "";
    switch (w) {
      case "TABLE": {
        const n = this.target("ddl", k + 1, "CREATE TABLE");
        if (n && isWord(t[n.end + 1], "LIKE")) this.target("read", n.end + 2, "LIKE");
        return;
      }
      case "VIEW": {
        const n = this.target("ddl", k + 1, "CREATE VIEW");
        if (n) this.createdView = n.parts;
        return;
      }
      case "ALIAS": {
        const n = this.target("ddl", k + 1, "CREATE ALIAS");
        if (!n || !isWord(t[n.end + 1], "FOR")) return;
        const base = readName(t, n.end + 2);
        if (!base) { this.danger("the object CREATE ALIAS refers to is not a name the guard can read"); return; }
        this.consume(base);
        this.op("read", base.parts); // what the alias exposes: a blocked library shows here
        const a = this.object(n.parts);
        const b = this.object(base.parts);
        if (a?.lib && b) this.run.state.local.set(`${a.lib}.${a.name}`, [b]);
        return;
      }
      case "INDEX":
      case "UNIQUE":
      case "ENCODED": {
        let x = k;
        while (x < k + 6 && !isWord(t[x], "INDEX")) x++;
        const n = this.target("ddl", x + 1, "CREATE INDEX");
        const on = n ? this.findWord(n.end + 1, "ON") : -1;
        if (on >= 0) this.target("read", on + 1, "ON");
        return;
      }
      case "PROCEDURE":
      case "FUNCTION": {
        const n = this.target("ddl", k + 1, `CREATE ${w}`);
        const ext = n ? this.findWord(n.end + 1, "EXTERNAL") : -1;
        if (ext >= 0 && isWord(t[ext + 1], "NAME")) {
          const pgm = readName(t, ext + 2); // EXTERNAL NAME LIB/PGM(ENTRY): not a call now
          if (pgm) { this.consume(pgm); if (isOp(t[pgm.end + 1], "(")) this.skip.add(pgm.end + 2); }
        }
        return; // the body is classified by the pass
      }
      case "TRIGGER":
      case "MASK":
      case "PERMISSION": {
        const n = this.target("ddl", k + 1, `CREATE ${w}`);
        const on = n ? this.findWord(n.end + 1, "ON") : -1;
        if (on >= 0) this.target("ddl", on + 1, "ON"); // the table it changes the behaviour of
        else this.danger(`CREATE ${w} without ON is not classified`);
        return;
      }
      case "SEQUENCE":
      case "VARIABLE":
      case "TYPE":
        this.target("ddl", k + 1, `CREATE ${w}`);
        return;
      case "DISTINCT":
        if (isWord(t[k + 1], "TYPE")) this.target("ddl", k + 2, "CREATE DISTINCT TYPE");
        else this.danger("CREATE DISTINCT without TYPE is not classified");
        return;
      case "SCHEMA":
      case "COLLECTION": {
        const n = readName(t, k + 1);
        if (!n || n.parts.length !== 1) this.danger("the schema CREATE SCHEMA makes is not a name the guard can read");
        else { this.consume(n); this.lib("ddl", n.parts[0]); }
        return;
      }
      default:
        this.danger(`CREATE ${w || t[k]?.value || ""} is not a statement the guard recognises`.trim());
    }
  }

  private alter(i: number): void {
    const t = this.t;
    let k = i + 1;
    if (isWord(t[k], "SPECIFIC")) k++;
    const w = t[k]?.type === "word" ? t[k].upper : "";
    if (w === "TABLE") {
      // ADD, DROP and ALTER inside ALTER TABLE are clauses, not statements
      for (let x = k; x < t.length && t[x].type !== "semi"; x++) if (isWord(t[x], "ADD", "DROP", "ALTER", "RENAME")) this.skip.add(x);
      this.target("ddl", k + 1, "ALTER TABLE");
      return;
    }
    if (["PROCEDURE", "FUNCTION", "SEQUENCE", "TRIGGER", "MASK", "PERMISSION"].includes(w)) {
      this.target("ddl", k + 1, `ALTER ${w}`);
      return;
    }
    this.danger(`ALTER ${w} is not a statement the guard recognises`.trim());
  }

  private drop(i: number): void {
    const t = this.t;
    let k = i + 1;
    if (isWord(t[k], "SPECIFIC")) k++;
    if (isWord(t[k], "DISTINCT")) k++;
    const w = t[k]?.type === "word" ? t[k].upper : "";
    if (!OBJECT_TYPES.has(w) || ["COLUMN", "CONSTRAINT", "PARAMETER", "SPECIFIC", "DISTINCT"].includes(w)) {
      this.danger(`DROP ${w} is not a statement the guard recognises`.trim());
      return;
    }
    k++;
    if (isWord(t[k], "IF") && isWord(t[k + 1], "EXISTS")) k += 2;
    if (w === "SCHEMA" || w === "COLLECTION") {
      const n = readName(t, k);
      if (!n || n.parts.length !== 1) this.danger("the schema DROP SCHEMA removes is not a name the guard can read");
      else { this.consume(n); this.lib("ddl", n.parts[0]); }
      return;
    }
    this.target("ddl", k, `DROP ${w}`);
  }

  // Skip object-type words (TABLE, SPECIFIC PROCEDURE, DISTINCT TYPE ...); returns the last one.
  private types(k: number): { k: number; last: string } {
    let last = "";
    while (this.t[k]?.type === "word" && OBJECT_TYPES.has(this.t[k].upper)) { last = this.t[k].upper; k++; }
    return { k, last };
  }

  private grant(i: number): void {
    const t = this.t;
    const on = this.findWord(i + 1, "ON");
    if (on < 0) { this.danger(`${t[i].upper} without ON is not classified`); this.toEnd(i); return; }
    let { k, last } = this.types(on + 1);
    for (;;) {
      const n = readName(t, k);
      if (!n) { this.danger(`the object ${t[i].upper} acts on is not a name the guard can read`); break; }
      if (last === "SCHEMA" || last === "COLLECTION") this.lib("ddl", n.parts[n.parts.length - 1]);
      else this.op("ddl", n.parts);
      k = n.end + 1;
      if (isOp(t[k], "(")) { const e = matchParen(t, k); if (e < 0) break; k = e + 1; } // a routine signature
      if (!isOp(t[k], ",")) break;
      k++;
    }
    this.toEnd(i); // privileges, TO and FROM grantees are not objects
  }

  private transfer(i: number): void {
    const t = this.t;
    if (!isWord(t[i + 1], "OWNERSHIP") || !isWord(t[i + 2], "OF")) { this.danger("TRANSFER without OWNERSHIP OF is not classified"); return; }
    const { k } = this.types(i + 3);
    this.target("ddl", k, "TRANSFER OWNERSHIP");
    this.toEnd(i);
  }

  private commentOn(i: number): void {
    const t = this.t;
    const { k, last } = this.types(i + 2);
    const n = readName(t, k);
    if (!n) { this.danger(`the object ${t[i].upper} ON acts on is not a name the guard can read`); this.toEnd(i); return; }
    if (last === "SCHEMA" || last === "COLLECTION") this.lib("ddl", n.parts[n.parts.length - 1]);
    else if (last === "COLUMN") {
      if (n.parts.length < 2) this.danger(`${t[i].upper} ON COLUMN needs table.column`);
      else this.op("ddl", n.parts.slice(0, -1));
    } else this.op("ddl", n.parts);
    this.toEnd(i);
  }

  private dgtt(i: number): void {
    const t = this.t;
    if (!isWord(t[i + 2], "TEMPORARY") || !isWord(t[i + 3], "TABLE")) { this.danger("DECLARE GLOBAL without TEMPORARY TABLE is not classified"); return; }
    const n = readName(t, i + 4);
    if (!n || n.parts.length > 2 || (n.parts.length === 2 && n.parts[0] !== "SESSION" && n.parts[0] !== "QTEMP")) {
      this.danger("a declared temporary table is named SESSION.T, QTEMP.T or T");
      return;
    }
    this.consume(n);
    this.op("ddl", ["QTEMP", n.parts[n.parts.length - 1]]);
    if (isWord(t[n.end + 1], "LIKE")) this.target("read", n.end + 2, "LIKE");
  }
}

// --- statements decided at their head ---

function connection(t: Token[], h: number, run: Run): Operation[] {
  const verb = t[h].upper === "SET" ? "SET CONNECTION" : t[h].upper;
  const at = t[h].upper === "SET" ? h + 2 : verb === "CONNECT" ? h + 2 : h + 1;
  if (verb === "CONNECT") {
    if (isWord(t[h + 1], "RESET")) { run.state.rdb = undefined; run.state.partition = undefined; return []; }
    if (!t[h + 1]) return []; // CONNECT alone reports the current connection
    if (!isWord(t[h + 1], "TO")) return [danger("sql", "CONNECT without TO changes the user or connection and is not classified", run)];
  }
  if (verb === "RELEASE" && isWord(t[h + 1], "SAVEPOINT", "TO")) return [];
  const x = t[at];
  if (!x) return [danger("sql", `${verb} needs a database name`, run)];
  if (verb !== "CONNECT" && verb !== "SET CONNECTION" && isWord(x, "CURRENT", "ALL")) {
    if (verb === "DISCONNECT") { run.state.rdb = undefined; run.state.partition = undefined; }
    return [];
  }
  const rdb = x.type === "string" ? x.value.toUpperCase() : isNamePart(x) ? x.upper : "";
  const partition = rdb ? run.rdbs[rdb] : undefined;
  if (!partition) return [danger("sql", `${verb} ${rdb || x.value}: ${rdb || "that"} is another database and no partition lists it in rdbs`, run)];
  if (verb === "CONNECT" || verb === "SET CONNECTION") { run.state.rdb = rdb; run.state.partition = partition; }
  else if (verb === "DISCONNECT" && run.state.rdb === rdb) { run.state.rdb = undefined; run.state.partition = undefined; }
  return [];
}

function set(t: Token[], h: number, run: Run): Operation[] {
  let k = h + 1;
  if (isWord(t[k], "CONNECTION")) return connection(t, h, run);
  if (isWord(t[k], "SESSION", "SESSION_USER")) return [danger("sql", "changing the session user is not classified", run)];
  const current = isWord(t[k], "CURRENT");
  if (current) k++;
  const w = t[k]?.type === "word" ? t[k].upper : "";
  if (SCHEMA_REGISTERS.has(w)) {
    k++;
    if (isOp(t[k], "=")) k++;
    const v = t[k];
    const lib = v?.type === "string" ? v.value.toUpperCase() : v?.type === "delim" || (v?.type === "word" && !KEYWORDS.has(v.upper) && !["USER", "SESSION_USER", "SYSTEM_USER"].includes(v.upper)) ? v.upper : undefined;
    const op: Operation = { class: "liblist", source: "sql" };
    if (lib) op.object = { lib, name: lib, type: "*LIB" };
    if (run.via.length) op.via = [...run.via];
    return [op];
  }
  if (PATH_REGISTERS.has(w)) {
    const op: Operation = { class: "liblist", source: "sql" };
    if (run.via.length) op.via = [...run.via];
    return [op];
  }
  const scan = new Scan(t, run);
  if (HARMLESS_SET.has(w)) { scan.scan(); return scan.ops; }
  if (current) return [danger("sql", `SET CURRENT ${w} is not a statement the guard recognises`, run)];
  // SET target = expression: a global variable is written
  const targets: string[][] = [];
  if (isOp(t[k], "(")) {
    for (k++; isNamePart(t[k]); ) {
      const n = readName(t, k)!;
      targets.push(n.parts);
      k = n.end + 1;
      if (isOp(t[k], ",")) k++;
    }
    if (isOp(t[k], ")")) k++;
  } else if (t[k]?.type === "delim" || (t[k]?.type === "word" && (!KEYWORDS.has(t[k].upper) || isOp(t[k + 1], ".")))) {
    const n = readName(t, k)!;
    targets.push(n.parts);
    k = n.end + 1;
  }
  if (!targets.length || !isOp(t[k], "=")) return [danger("sql", `SET ${w || ""} is not a statement the guard recognises`.replace("  ", " "), run)];
  const rest = new Scan(t.slice(k + 1), run);
  rest.scan();
  const ops = targets.map((parts) => {
    const [lib, name] = parts.length === 2 ? parts : [undefined, parts[parts.length - 1]];
    return objectOp("write", lib ? { lib, name } : { name }, "sql", run);
  });
  return [...ops, ...rest.ops];
}

export interface SqlResult {
  operations: Operation[];
  createdView?: string[];
}

export function classifySqlTokens(t: Token[], run: Run): SqlResult {
  let h = 0;
  while (isOp(t[h], "(")) h++;
  const head = t[h];
  if (!head) return { operations: [] };
  if (head.type !== "word" || !HEADS.has(head.upper)) {
    return { operations: [danger("sql", `"${head.value}" does not start a statement the guard recognises`, run)] };
  }
  switch (head.upper) {
    case "SET":
      return { operations: set(t, h, run) };
    case "CONNECT":
    case "DISCONNECT":
    case "RELEASE":
      return { operations: connection(t, h, run) };
    case "COMMIT":
    case "ROLLBACK":
    case "SAVEPOINT":
      return { operations: [] };
    case "DECLARE":
      if (!isWord(t[h + 1], "GLOBAL")) return { operations: [danger("sql", "DECLARE is only classified as DECLARE GLOBAL TEMPORARY TABLE", run)] };
  }
  // Only a routine, trigger or compound statement has a body with semicolons in it.
  const lead = t.slice(h, h + 6).filter((x) => x.type === "word").map((x) => x.upper);
  const body = lead[0] === "BEGIN" || (["CREATE", "ALTER"].includes(lead[0]) && lead.some((w) => ["PROCEDURE", "FUNCTION", "TRIGGER"].includes(w)));
  if (!body && t.some((x) => x.type === "semi")) {
    return { operations: [danger("sql", "a semicolon inside one statement: only a routine, trigger or BEGIN ... END body may hold one", run)] };
  }
  const scan = new Scan(t, run);
  scan.scan();
  if (!scan.ops.length && CHANGE_HEADS.has(head.upper)) {
    return { operations: [danger("sql", `the guard could not read what this ${head.upper} statement acts on`, run)] };
  }
  return { operations: scan.ops, createdView: scan.createdView };
}
