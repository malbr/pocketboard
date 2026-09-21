// Run with `node --test scripts/release/`. Uses only Node built-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "check-migrations.mjs");
const repoMigrations = path.join(here, "..", "..", "packages", "api", "migrations");

// Builds a migrations folder the way drizzle-kit lays it out: SQL files plus a
// journal naming each one.
function migrations(files, journalTags = Object.keys(files)) {
  const dir = mkdtempSync(path.join(tmpdir(), "migrations-"));
  mkdirSync(path.join(dir, "meta"));
  for (const [tag, sql] of Object.entries(files)) {
    writeFileSync(path.join(dir, `${tag}.sql`), sql);
  }
  const entries = journalTags.map((tag, idx) => ({ idx, version: "7", when: idx, tag, breakpoints: true }));
  writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
}

function assertAccepted(sql) {
  const result = run(migrations({ "0000_x": sql }));
  assert.equal(result.status, 0, result.stderr);
}

function assertRejected(sql, fragment) {
  const result = run(migrations({ "0000_x": sql }));
  assert.equal(result.status, 1, `expected rejection of: ${sql}\n${result.stdout}`);
  assert.match(result.stderr, fragment);
}

test("the repository's own migrations are all backward compatible", () => {
  const result = run(repoMigrations);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 migrations checked/);
});

test("additive changes pass", () => {
  assertAccepted(`CREATE TYPE "public"."s" AS ENUM('a');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t" ("id" uuid PRIMARY KEY NOT NULL, "n" text NOT NULL);
CREATE INDEX IF NOT EXISTS "t_n_idx" ON "t" USING btree ("n");
ALTER TABLE "cards" ADD COLUMN "note" text;
ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;
ALTER TYPE "public"."card_status" ADD VALUE 'archived';`);
});

test("keywords inside comments and string literals are ignored", () => {
  assertAccepted(`-- we never DROP TABLE here
/* nor DELETE FROM cards */
CREATE TABLE "notes" ("body" text DEFAULT 'drop table cards; truncate x' NOT NULL);`);
});

test("data-destroying statements are rejected", () => {
  assertRejected(`DROP TABLE "cards";`, /DROP/);
  assertRejected(`ALTER TABLE "cards" DROP COLUMN "title";`, /DROP/);
  assertRejected(`DROP INDEX "sessions_expires_at_idx";`, /DROP/);
  assertRejected(`TRUNCATE "cards";`, /TRUNCATE/);
  assertRejected(`DELETE FROM "cards";`, /DELETE/);
  assertRejected(`UPDATE "cards" SET "title" = '';`, /UPDATE/);
});

test("changes an older image cannot live with are rejected", () => {
  assertRejected(`ALTER TABLE "cards" RENAME COLUMN "title" TO "name";`, /RENAME/);
  assertRejected(`ALTER TABLE "cards" RENAME TO "tasks";`, /RENAME/);
  assertRejected(`ALTER TYPE "public"."card_status" RENAME VALUE 'doing' TO 'wip';`, /RENAME/);
  assertRejected(`ALTER TABLE "cards" ALTER COLUMN "title" TYPE varchar(20);`, /column type/);
  assertRejected(`ALTER TABLE "cards" ALTER COLUMN "title" SET DATA TYPE varchar(20);`, /column type/);
  assertRejected(`ALTER TABLE "cards" ALTER COLUMN "note" SET NOT NULL;`, /SET NOT NULL/);
  assertRejected(`ALTER TABLE "cards" ADD COLUMN "owner" text NOT NULL;`, /NOT NULL without a DEFAULT/);
  assertRejected(`ALTER TABLE "cards" ADD CONSTRAINT "c" CHECK (length("title") < 5);`, /constraint/);
  assertRejected(`CREATE UNIQUE INDEX "cards_title_idx" ON "cards" ("title");`, /unique index/);
});

test("DDL inside a DO block is checked, not hidden", () => {
  assertRejected(`DO $$ BEGIN
 ALTER TABLE "cards" DROP COLUMN "title";
EXCEPTION WHEN undefined_column THEN null;
END $$;`, /DROP/);
});

test("constraints and NOT NULL on a table created in the same migration are allowed", () => {
  assertAccepted(`CREATE TABLE IF NOT EXISTS "labels" ("id" uuid PRIMARY KEY NOT NULL, "card_id" uuid);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "labels" ADD CONSTRAINT "labels_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX "labels_name_idx" ON "labels" ("name");
ALTER TABLE "labels" ADD COLUMN "name" text NOT NULL;
ALTER TABLE "labels" ALTER COLUMN "card_id" SET NOT NULL;`);
});

test("destructive statements stay rejected even on a new table", () => {
  assertRejected(`CREATE TABLE "labels" ("id" uuid);
DROP TABLE "labels";`, /DROP/);
});

test("a rejection names the file and statement", () => {
  const result = run(migrations({ "0007_bad": `SELECT 1;\nDROP TABLE "cards";` }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /0007_bad\.sql/);
  assert.match(result.stderr, /DROP TABLE "cards"/);
  assert.match(result.stderr, /separate human-approved issue/);
});

test("fails closed when it cannot prove what it checked", () => {
  assert.equal(run(path.join(tmpdir(), "does-not-exist-migrations")).status, 2);
  assert.equal(run(migrations({})).status, 2, "an empty journal proves nothing");
  const unlisted = run(migrations({ "0000_a": "SELECT 1;", "0001_b": "SELECT 1;" }, ["0000_a"]));
  assert.equal(unlisted.status, 2);
  assert.match(unlisted.stderr, /0001_b\.sql is not in the journal/);
  const missing = run(migrations({ "0000_a": "SELECT 1;" }, ["0000_a", "0001_b"]));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /0001_b has no SQL file/);
  assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
});

// Counterexamples from the PR #29 review
// (https://github.com/malbr/pocketboard/pull/29#issuecomment-5733203079).
// Each one was accepted by the regex-based guard.
const existingCards = `CREATE TABLE "cards" ("id" uuid PRIMARY KEY NOT NULL, "title" text NOT NULL);`;

function assertRejectedAfter(history, sql, fragment) {
  const result = run(migrations({ "0000_base": history, "0001_x": sql }));
  assert.equal(result.status, 1, `expected rejection of: ${sql}\n${result.stdout}`);
  assert.match(result.stderr, fragment);
}

test("a comment marker inside a literal cannot hide a statement", () => {
  assertRejected(`DO $$ BEGIN RAISE NOTICE '--'; DROP TABLE cards; END $$;`, /DO block/);
  assertRejected(`CREATE TABLE "n" ("b" text DEFAULT '--');
DROP TABLE cards;`, /DROP/);
  assertRejected(`CREATE TABLE "n" ("b" text DEFAULT '/*');
DROP TABLE cards; -- */`, /DROP/);
});

test("dynamic SQL and data changes inside DO blocks or CTEs are rejected", () => {
  assertRejected(`DO $$ BEGIN EXECUTE 'DROP TABLE cards'; END $$;`, /DO block/);
  assertRejected(`DO $$ BEGIN UPDATE cards SET title = ''; END $$;`, /DO block/);
  assertRejected(`DO $body$ BEGIN
 ALTER TABLE "cards" ADD COLUMN "n" text;
 PERFORM pg_sleep(1);
EXCEPTION WHEN duplicate_object THEN null;
END $body$;`, /DO block/);
  assertRejected(`WITH gone AS (DELETE FROM cards RETURNING id) SELECT count(*) FROM gone;`, /unsupported statement/);
  assertRejected(`WITH x AS (UPDATE cards SET title = '' RETURNING id) SELECT 1;`, /unsupported statement/);
  assertRejected(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity;`, /unsupported statement/);
  assertRejected(`CREATE FUNCTION f() RETURNS void AS $$ DELETE FROM cards $$ LANGUAGE sql;`, /unsupported statement/);
});

test("the optional COLUMN keyword does not bypass column rules", () => {
  assertRejectedAfter(existingCards, `ALTER TABLE cards ALTER title TYPE varchar(20);`, /column type/);
  assertRejectedAfter(existingCards, `ALTER TABLE cards ALTER title SET DATA TYPE varchar(20);`, /column type/);
  assertRejectedAfter(existingCards, `ALTER TABLE cards ADD owner text NOT NULL;`, /NOT NULL without a DEFAULT/);
  assertRejectedAfter(existingCards, `ALTER TABLE cards ALTER title DROP DEFAULT;`, /unsupported ALTER TABLE action/);
});

test("a DEFAULT on one added column does not exempt another", () => {
  assertRejectedAfter(
    existingCards,
    `ALTER TABLE cards ADD COLUMN a text DEFAULT 'x', ADD COLUMN b text NOT NULL;`,
    /NOT NULL without a DEFAULT: .*\bb\b/,
  );
  assertRejectedAfter(existingCards, `ALTER TABLE cards ADD COLUMN b text DEFAULT NULL NOT NULL;`, /NOT NULL without a DEFAULT/);
});

test("CREATE TABLE IF NOT EXISTS on an existing table does not make it new", () => {
  assertRejectedAfter(
    existingCards,
    `CREATE TABLE IF NOT EXISTS cards (id uuid);
ALTER TABLE cards ADD COLUMN owner text NOT NULL;`,
    /already exists/,
  );
  assertRejectedAfter(
    existingCards,
    `CREATE TABLE IF NOT EXISTS cards (id uuid);
ALTER TABLE cards ADD COLUMN owner text NOT NULL;`,
    /NOT NULL without a DEFAULT/,
  );
});

test("schema and quoted case distinguish relations", () => {
  assertRejectedAfter(
    existingCards,
    `CREATE TABLE archive.cards (id uuid);
ALTER TABLE public.cards ADD COLUMN owner text NOT NULL;`,
    /NOT NULL without a DEFAULT/,
  );
  assertRejectedAfter(
    existingCards,
    `CREATE TABLE "Cards" (id uuid);
ALTER TABLE cards ADD CONSTRAINT c CHECK (length(title) < 5);`,
    /constraint/,
  );
  assertAccepted(`CREATE TABLE "Labels" ("id" uuid);
ALTER TABLE "Labels" ADD COLUMN "name" text NOT NULL;`);
});

test("column constraints added to an existing table are rejected", () => {
  assertRejectedAfter(existingCards, `ALTER TABLE cards ADD COLUMN code text UNIQUE;`, /constraint/);
  assertRejectedAfter(existingCards, `ALTER TABLE cards ADD COLUMN n int CHECK (n > 0);`, /constraint/);
});

test("unterminated literals and comments fail closed", () => {
  assertRejected(`CREATE TABLE "n" ("b" text DEFAULT 'oops);`, /unterminated/);
  assertRejected(`/* never closed
CREATE TABLE "n" ("b" text);`, /unterminated/);
  assertRejected(`DO $$ BEGIN NULL; END;`, /unterminated/);
});

test("E-string escapes are respected", () => {
  assertRejected(String.raw`CREATE TABLE "n" ("b" text DEFAULT E'it\'s');
DROP TABLE cards;`, /DROP/);
});
