import fs from "node:fs";
import { renderOpenApiDocument } from "./document";

export type OpenApiCheck = { ok: true } | { ok: false; reason: "missing" | "drift"; message: string };

export function writeOpenApiFile(file: string): void {
  fs.writeFileSync(file, renderOpenApiDocument());
}

export function checkOpenApiFile(file: string): OpenApiCheck {
  if (!fs.existsSync(file)) {
    return { ok: false, reason: "missing", message: `${file} does not exist; run npm run openapi:generate` };
  }
  // Line endings are normalised so a Windows checkout does not read as drift.
  const committed = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (committed !== renderOpenApiDocument()) {
    return {
      ok: false,
      reason: "drift",
      message: `${file} is out of date with the API contract; run npm run openapi:generate and commit the result`,
    };
  }
  return { ok: true };
}
