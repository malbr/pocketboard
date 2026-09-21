// Fails when a Drizzle migration would destroy data or break the previous
// application image, because production rolls back the image without rolling
// back the database (issue #8). There is deliberately no allowlist or bypass:
// such a migration needs its own human-approved issue that designs one.
//
// The check is an allowlist, not a blocklist. Each statement is tokenised with
// PostgreSQL's lexical rules and must match one of a few additive shapes
// (CREATE TYPE ... AS ENUM, CREATE TABLE, CREATE INDEX, ALTER TABLE ... ADD,
// ALTER TYPE ... ADD VALUE, and Drizzle's single-statement DO wrapper). Anything
// else, including dynamic SQL, functions, CTEs and data changes, is rejected.
//
// Usage: node scripts/release/check-migrations.mjs <migrations folder>
// Exit 0: every journal entry checked and compatible. Exit 1: findings.
// Exit 2: the folder could not be checked, which never counts as a pass.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function cannotCheck(message) {
  console.error(`check-migrations: ${message}`);
  process.exit(2);
}

const dir = process.argv[2];
if (!dir) cannotCheck("usage: check-migrations.mjs <migrations folder>");
const journalPath = path.join(dir, "meta", "_journal.json");
if (!existsSync(journalPath)) cannotCheck(`no journal at ${journalPath}`);

let tags;
try {
  tags = JSON.parse(readFileSync(journalPath, "utf8")).entries.map((entry) => entry.tag);
} catch (error) {
  cannotCheck(`unreadable journal ${journalPath}: ${error.message}`);
}
if (tags.length === 0) cannotCheck("the journal lists no migrations");

// The migrator only runs journal entries, so an unlisted file or a listed file
// that is missing means this check and production disagree about what runs.
const files = readdirSync(dir).filter((name) => name.endsWith(".sql"));
const problems = [
  ...files.filter((name) => !tags.includes(name.slice(0, -4))).map((name) => `${name} is not in the journal`),
  ...tags.filter((tag) => !files.includes(`${tag}.sql`)).map((tag) => `journal entry ${tag} has no SQL file`),
];
if (problems.length > 0) cannotCheck(problems.join("\n"));

class Unparseable extends Error {}

// NAMEDATALEN - 1 in a default PostgreSQL build.
const MAX_IDENTIFIER_BYTES = 63;

// Splits SQL into tokens, following
// https://www.postgresql.org/docs/16/sql-syntax-lexical.html: nested block
// comments, line comments, '' literals (backslash escapes only in E''),
// "quoted identifiers", and $tag$ dollar-quoted bodies. Comments are dropped;
// everything else keeps its source offsets so findings can quote the input.
// As in PostgreSQL's scanner, whitespace is exactly [ \t\n\r\f\v] and a line
// comment ends at either CR or LF.
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  const push = (type, value, start) => tokens.push({ type, value, start, end: i });
  // PostgreSQL silently truncates a longer identifier, which could turn a name
  // this check tracks as new into an existing relation.
  const pushName = (type, value, start) => {
    if (Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES) {
      throw new Unparseable(`identifier longer than ${MAX_IDENTIFIER_BYTES} bytes would be truncated: ${value}`);
    }
    push(type, value, start);
  };
  while (i < sql.length) {
    const c = sql[i];
    const start = i;
    if (/[ \t\n\r\f\v]/.test(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      let depth = 0;
      do {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else if (i >= sql.length) {
          throw new Unparseable("unterminated block comment");
        } else {
          i++;
        }
      } while (depth > 0);
    } else if (c === "'" || ((c === "E" || c === "e") && sql[i + 1] === "'")) {
      const escapes = c !== "'";
      i += escapes ? 2 : 1;
      let value = "";
      for (;;) {
        if (i >= sql.length) throw new Unparseable("unterminated string literal");
        if (escapes && sql[i] === "\\") {
          value += sql[i + 1] ?? "";
          i += 2;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          value += sql[i++];
        }
      }
      push("string", value, start);
    } else if (c === '"') {
      i++;
      let value = "";
      for (;;) {
        if (i >= sql.length) throw new Unparseable("unterminated quoted identifier");
        if (sql[i] === '"' && sql[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          value += sql[i++];
        }
      }
      pushName("ident", value, start);
    } else if (c === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)[0];
      const close = sql.indexOf(tag, i + tag.length);
      if (close < 0) throw new Unparseable("unterminated dollar-quoted string");
      const body = sql.slice(i + tag.length, close);
      i = close + tag.length;
      push("dollar", body, start);
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      while (i < sql.length && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i])) i++;
      // Unquoted identifiers and keywords fold to lower case; in UTF-8 only
      // ASCII letters fold.
      pushName("word", sql.slice(start, i).replace(/[A-Z]/g, (letter) => letter.toLowerCase()), start);
    } else if (/[0-9]/.test(c)) {
      while (i < sql.length && /[0-9.eE]/.test(sql[i])) i++;
      push("number", sql.slice(start, i), start);
    } else {
      i++;
      push("punct", c, start);
    }
  }
  return tokens;
}

function splitStatements(tokens) {
  const statements = [];
  let current = [];
  for (const token of tokens) {
    if (token.type === "punct" && token.value === ";") {
      if (current.length > 0) statements.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

// Splits at commas outside parentheses: ALTER TABLE actions, for example.
function splitTopLevel(tokens) {
  const parts = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.type === "punct" && token.value === "(") depth++;
    if (token.type === "punct" && token.value === ")") depth--;
    if (depth === 0 && token.type === "punct" && token.value === ",") parts.push([]);
    else parts.at(-1).push(token);
  }
  return parts;
}

// A cursor over one statement's tokens.
function cursor(tokens) {
  let i = 0;
  const peek = (offset = 0) => tokens[i + offset];
  const isWord = (token, ...words) => token?.type === "word" && words.includes(token.value);
  return {
    get done() {
      return i >= tokens.length;
    },
    rest: () => tokens.slice(i),
    skip: () => i++,
    peek,
    at: (...words) => words.every((word, k) => isWord(peek(k), word)),
    accept(...words) {
      if (!words.every((word, k) => isWord(peek(k), word))) return false;
      i += words.length;
      return true;
    },
    punct(value) {
      if (peek()?.type !== "punct" || peek().value !== value) return false;
      i++;
      return true;
    },
    // Schema-qualified relation name. Unqualified names resolve to `public`,
    // the migrator's search path; quoted names keep their case.
    name() {
      const parts = [];
      do {
        const token = peek();
        if (token?.type !== "word" && token?.type !== "ident") return undefined;
        parts.push(token.value);
        i++;
      } while (this.punct("."));
      if (parts.length > 2) return undefined;
      return parts.length === 1 ? `public.${parts[0]}` : parts.join(".");
    },
    // Consumes one balanced (...) group.
    group() {
      if (!this.punct("(")) return false;
      let depth = 1;
      while (depth > 0) {
        const token = tokens[i++];
        if (!token) return false;
        if (token.type === "punct" && token.value === "(") depth++;
        if (token.type === "punct" && token.value === ")") depth--;
      }
      return true;
    },
  };
}

const CONSTRAINT_WORDS = ["constraint", "primary", "unique", "check", "foreign", "exclude", "references", "generated"];

// Checks one statement. `known` holds every relation created by an earlier
// migration or statement; `fresh` holds those created in this migration,
// which have no rows and no older image that uses them.
function checkStatement(tokens, { known, fresh }, report, insideDo = false) {
  const s = cursor(tokens);
  const first = s.peek();
  if (first?.type !== "word") return report("unsupported statement");

  if (s.accept("create", "type")) {
    const name = s.name();
    if (!name || !s.accept("as", "enum") || !s.group() || !s.done) return report("unsupported CREATE TYPE");
    return;
  }

  if (s.accept("create", "table")) {
    s.accept("if", "not", "exists");
    const name = s.name();
    if (!name || !s.group() || !s.done) return report("unsupported CREATE TABLE form");
    if (known.has(name)) return report(`creates a table that already exists (${name})`);
    known.add(name);
    fresh.add(name);
    return;
  }

  if (s.at("create", "index") || s.at("create", "unique", "index")) {
    s.accept("create");
    const unique = s.accept("unique");
    s.accept("index");
    s.accept("concurrently");
    s.accept("if", "not", "exists");
    if (!s.at("on")) s.name();
    if (!s.accept("on")) return report("unsupported CREATE INDEX form");
    s.accept("only");
    const table = s.name();
    if (!table) return report("unsupported CREATE INDEX form");
    if (unique && !fresh.has(table)) report("adds a unique index to an existing table");
    return;
  }

  if (s.accept("alter", "type")) {
    if (!s.name()) return report("unsupported ALTER TYPE");
    if (s.at("rename")) return report("RENAME");
    if (!s.accept("add", "value")) return report("unsupported ALTER TYPE action");
    s.accept("if", "not", "exists");
    if (s.peek()?.type !== "string") return report("unsupported ALTER TYPE action");
    const tail = s.rest().slice(1);
    const validTail =
      tail.length === 0 ||
      (tail.length === 2 && ["before", "after"].includes(tail[0].value) && tail[1].type === "string");
    if (!validTail) report("unsupported ALTER TYPE action");
    return;
  }

  if (s.accept("alter", "table")) {
    s.accept("if", "exists");
    s.accept("only");
    const table = s.name();
    if (!table) return report("unsupported ALTER TABLE form");
    if (s.at("rename")) return report("RENAME");
    for (const action of splitTopLevel(s.rest())) {
      checkAlterAction(action, fresh.has(table), report);
    }
    return;
  }

  if (s.at("do")) {
    return checkDoBlock(tokens, { known, fresh }, report, insideDo);
  }

  const leading = { drop: "DROP", truncate: "TRUNCATE", delete: "DELETE", update: "UPDATE rewrites existing rows" };
  if (leading[first.value]) return report(leading[first.value]);
  return report("unsupported statement");
}

function checkAlterAction(tokens, freshTable, report) {
  const a = cursor(tokens);
  if (a.at("drop")) return report("DROP");
  if (a.at("rename")) return report("RENAME");

  if (a.accept("add")) {
    const tableConstraint = ["constraint", "primary", "unique", "check", "foreign", "exclude"].some((word) => a.at(word));
    if (tableConstraint) {
      if (!freshTable) report("adds a constraint to an existing table");
      return;
    }
    a.accept("column");
    a.accept("if", "not", "exists");
    const column = a.peek();
    if (column?.type !== "word" && column?.type !== "ident") return report("unsupported ALTER TABLE action");
    if (freshTable) return;
    const definition = a.rest().slice(1);
    const words = definition.filter((token) => token.type === "word").map((token) => token.value);
    if (CONSTRAINT_WORDS.some((word) => words.includes(word))) {
      report(`adds a constraint to an existing table: ${column.value}`);
    }
    const notNull = definition.some((token, k) => token.value === "not" && definition[k + 1]?.value === "null");
    const defaultAt = definition.findIndex((token) => token.type === "word" && token.value === "default");
    let nonNullDefault = false;
    if (defaultAt >= 0) {
      const expression = defaultExpression(definition.slice(defaultAt + 1));
      if (!expression) return report(`adds an unsupported DEFAULT expression to an existing table: ${column.value}`);
      nonNullDefault = expression !== "null";
    }
    if (notNull && !nonNullDefault) report(`adds a NOT NULL without a DEFAULT: ${column.value}`);
    return;
  }

  if (a.accept("alter")) {
    a.accept("column");
    if (!a.name()) return report("unsupported ALTER TABLE action");
    if (a.at("type") || a.at("set", "data", "type")) return report("changes a column type");
    if (a.at("set", "not", "null")) {
      if (!freshTable) report("SET NOT NULL");
      return;
    }
    if (a.accept("set", "default") && !a.done) {
      // The previous image may rely on the old default when it inserts.
      if (!freshTable) report("changes a column default on an existing table");
      return;
    }
  }
  return report("unsupported ALTER TABLE action");
}

// Adding a column evaluates its default for every existing row, and the
// previous image inserts rows without naming the column. An existing table may
// therefore only gain a constant or a side-effect-free built-in, followed by
// nothing but NULL or NOT NULL. Returns "null", "value", or undefined when the
// expression is not one of those shapes.
const DEFAULT_FUNCTIONS = ["now", "gen_random_uuid"];
function defaultExpression(tokens) {
  const d = cursor(tokens);
  let kind = "value";
  if (d.accept("null")) {
    kind = "null";
  } else if (d.accept("true") || d.accept("false") || d.accept("current_timestamp")) {
    // A constant.
  } else if (DEFAULT_FUNCTIONS.some((name) => d.accept(name))) {
    if (!d.punct("(") || !d.punct(")")) return undefined;
  } else if (d.peek()?.type === "string") {
    d.skip();
    // An optional cast to a named type, such as '{}'::jsonb.
    if (d.punct(":") && !(d.punct(":") && d.name())) return undefined;
  } else {
    if (!d.punct("-")) d.punct("+");
    if (d.peek()?.type !== "number") return undefined;
    d.skip();
  }
  const tail = d.rest().map((token) => (token.type === "word" ? token.value : "?")).join(" ");
  return ["", "null", "not null"].includes(tail) ? kind : undefined;
}

// Drizzle wraps some DDL as
//   DO $$ BEGIN <one statement>; EXCEPTION WHEN <condition> THEN null; END $$;
// Exactly that shape is accepted, and the inner statement is checked like any
// other. Any other PL/pgSQL (EXECUTE, several statements, PERFORM, loops) is
// dynamic code this check cannot reason about.
function checkDoBlock(tokens, state, report, insideDo) {
  const reject = () => report("DO block is not a single guarded statement");
  const [, body, ...tail] = tokens;
  if (insideDo || body?.type !== "dollar") return reject();
  const languageOk =
    tail.length === 0 ||
    (tail.length === 2 && tail[0].type === "word" && tail[0].value === "language" && tail[1].value === "plpgsql");
  if (!languageOk) return reject();

  let inner;
  try {
    inner = splitStatements(tokenize(body.value));
  } catch (error) {
    return report(error.message);
  }
  const words = (statement) => statement.map((token) => (token.type === "word" ? token.value : `\u0000${token.value}`));
  if (inner.length < 2 || words(inner[0])[0] !== "begin") return reject();
  const statement = inner[0].slice(1);
  const last = words(inner.at(-1));
  if (inner.length === 2) {
    if (last.join(" ") !== "end") return reject();
  } else if (inner.length === 3) {
    const handler = words(inner[1]);
    const guarded =
      handler[0] === "exception" &&
      handler[1] === "when" &&
      handler.at(-2) === "then" &&
      handler.at(-1) === "null" &&
      handler.slice(2, -2).every((word, k) => (k % 2 === 0 ? /^[a-z_]+$/.test(word) : word === "or"));
    if (!guarded || last.join(" ") !== "end") return reject();
  } else {
    return reject();
  }
  if (statement.length === 0) return reject();
  checkStatement(statement, state, (reason) => report(`DO block: ${reason}`), true);
}

const findings = [];
const known = new Set();
for (const tag of tags) {
  const file = `${tag}.sql`;
  const source = readFileSync(path.join(dir, file), "utf8");
  let statements;
  try {
    statements = splitStatements(tokenize(source));
  } catch (error) {
    findings.push(`${file}: ${error.message}; the file cannot be checked`);
    continue;
  }
  const fresh = new Set();
  for (const tokens of statements) {
    const text = source.slice(tokens[0].start, tokens.at(-1).end).replace(/\s+/g, " ");
    checkStatement(tokens, { known, fresh }, (reason) => findings.push(`${file}: ${reason}: ${text}`));
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  console.error(
    "Destructive or rollback-incompatible migrations need a separate human-approved issue; this check has no bypass.",
  );
  process.exit(1);
}
console.log(`${tags.length} migrations checked; all are backward compatible`);
