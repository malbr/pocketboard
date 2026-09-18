// Fails when a Drizzle migration would destroy data or break the previous
// application image, because production rolls back the image without rolling
// back the database (issue #8). There is deliberately no allowlist or bypass:
// such a migration needs its own human-approved issue that designs one.
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

// Comments and quoted literals are blanked so their text cannot trigger or
// hide a rule. Dollar-quoted bodies are kept: Drizzle emits DDL inside
// `DO $$ ... $$` blocks, and that DDL must be checked like any other.
function strip(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

const tableName = (quoted) => quoted.split(".").pop().replace(/"/g, "").toLowerCase();
const IDENT = String.raw`((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?)`;
const CREATE_TABLE = new RegExp(String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`, "gi");
const ALTER_TABLE = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}`, "i");
const UNIQUE_INDEX_ON = new RegExp(String.raw`\bCREATE\s+UNIQUE\s+INDEX\b.*?\bON\s+(?:ONLY\s+)?${IDENT}`, "is");

// Always rejected: these lose data or break an older image whatever the table.
const destructive = [
  [/\bDROP\b/i, "DROP"],
  [/\bTRUNCATE\b/i, "TRUNCATE"],
  [/^\s*DELETE\b|\bDELETE\s+FROM\b/i, "DELETE"],
  [/^\s*UPDATE\b/i, "UPDATE rewrites existing rows"],
  [/\bRENAME\b/i, "RENAME"],
  [/\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i, "changes a column type"],
];

// Rejected only on tables that already existed: an older image still writes
// rows that would violate them. A table created in the same migration has no
// rows and no older image that knows it.
const incompatibleOnExistingTable = [
  [/\bSET\s+NOT\s+NULL\b/i, "SET NOT NULL"],
  [(s) => /\bADD\s+COLUMN\b/i.test(s) && /\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s), "adds a NOT NULL without a DEFAULT"],
  [/\bADD\s+(?:CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/i, "adds a constraint"],
];

const findings = [];
for (const tag of tags) {
  const file = `${tag}.sql`;
  const sql = strip(readFileSync(path.join(dir, file), "utf8"));
  const created = new Set([...sql.matchAll(CREATE_TABLE)].map((match) => tableName(match[1])));
  const statements = sql.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

  for (const statement of statements) {
    const report = (reason) => findings.push(`${file}: ${reason}: ${statement}`);
    for (const [pattern, reason] of destructive) {
      if (pattern.test(statement)) report(reason);
    }
    const altered = statement.match(ALTER_TABLE);
    if (altered && !created.has(tableName(altered[1]))) {
      for (const [rule, reason] of incompatibleOnExistingTable) {
        if (typeof rule === "function" ? rule(statement) : rule.test(statement)) report(reason);
      }
    }
    const unique = statement.match(UNIQUE_INDEX_ON);
    if (unique && !created.has(tableName(unique[1]))) report("adds a unique index to an existing table");
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
