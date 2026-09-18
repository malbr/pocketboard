import path from "node:path";
import { checkOpenApiFile, writeOpenApiFile } from "./file";

const file = path.join(import.meta.dirname, "..", "..", "openapi.json");
const mode = process.argv[2];

if (mode === "write") {
  writeOpenApiFile(file);
  console.log(`wrote ${file}`);
} else if (mode === "check") {
  const result = checkOpenApiFile(file);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log("openapi.json matches the API contract");
} else {
  console.error("usage: cli.ts <write|check>");
  process.exit(2);
}
