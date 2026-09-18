// Fails when any SARIF file in a directory reports any result. CodeQL results
// are not uploaded to code scanning, so this is the gate: there is no alert
// to dismiss and no severity threshold to tune down. A missing or malformed
// SARIF file fails too, so an analysis that did not run cannot pass.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: fail-on-sarif-results.mjs <directory containing .sarif files>");
  process.exit(2);
}

function sarifFiles(root) {
  return readdirSync(root).flatMap((name) => {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) return sarifFiles(full);
    return name.endsWith(".sarif") ? [full] : [];
  });
}

const files = sarifFiles(dir);
if (files.length === 0) {
  console.error(`no SARIF files found under ${dir}; refusing to treat the analysis as clean`);
  process.exit(1);
}

const findings = [];
for (const file of files) {
  const sarif = JSON.parse(readFileSync(file, "utf8"));
  for (const run of sarif.runs ?? []) {
    if (!Array.isArray(run.results)) {
      console.error(`${file}: a run has no results array; refusing to treat it as clean`);
      process.exit(1);
    }
    for (const result of run.results) {
      const location = result.locations?.[0]?.physicalLocation;
      const where = location
        ? `${location.artifactLocation?.uri}:${location.region?.startLine ?? "?"}`
        : "unknown location";
      findings.push(`${result.ruleId ?? "unknown-rule"} (${result.level ?? "warning"}) at ${where}: ${result.message?.text ?? ""}`);
    }
  }
}

if (findings.length > 0) {
  console.error(`${findings.length} CodeQL results:`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}
console.log(`0 CodeQL results in ${files.length} SARIF file${files.length === 1 ? "" : "s"}`);
