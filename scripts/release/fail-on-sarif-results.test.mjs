// Run with `node --test scripts/release/`. Uses only Node built-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "fail-on-sarif-results.mjs");

function sarifDir(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "sarif-"));
  for (const [name, runs] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify({ version: "2.1.0", runs }));
  }
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
}

const run0 = { tool: { driver: { name: "CodeQL" } }, results: [] };
const finding = {
  ruleId: "js/sql-injection",
  level: "error",
  message: { text: "Query built from user input" },
  locations: [{ physicalLocation: { artifactLocation: { uri: "packages/api/src/x.ts" }, region: { startLine: 7 } } }],
};

test("passes when every run has zero results", () => {
  const result = run(sarifDir({ "js.sarif": [run0] }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 CodeQL results in 1 SARIF file/);
});

test("fails and names the rule and location for any result", () => {
  const result = run(sarifDir({ "js.sarif": [{ ...run0, results: [finding] }] }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /js\/sql-injection/);
  assert.match(result.stderr, /packages\/api\/src\/x\.ts:7/);
});

test("fails on a note-level result too: no severity is waved through", () => {
  const result = run(sarifDir({ "js.sarif": [{ ...run0, results: [{ ...finding, level: "note" }] }] }));
  assert.equal(result.status, 1);
});

test("counts results across several files", () => {
  const result = run(sarifDir({ "a.sarif": [run0], "b.sarif": [{ ...run0, results: [finding, finding] }] }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /2 CodeQL results/);
});

test("fails closed when no SARIF file exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sarif-"));
  mkdirSync(path.join(dir, "empty"));
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no SARIF/);
});

test("fails closed when a run has no results array", () => {
  const result = run(sarifDir({ "js.sarif": [{ tool: run0.tool }] }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no results array/);
});

test("fails closed on unreadable SARIF", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sarif-"));
  writeFileSync(path.join(dir, "bad.sarif"), "{not json");
  const result = run(dir);
  assert.equal(result.status, 1);
});
