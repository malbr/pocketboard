import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Database } from "../db/client";
import { buildTestApp } from "../testing/build-test-app";
import { documentedRoutes, generateOpenApiDocument, renderOpenApiDocument } from "./document";
import { checkOpenApiFile, writeOpenApiFile } from "./file";

/**
 * Fastify has no public route list, so the documented tree from printRoutes is
 * parsed. Each line is `<tree glyphs><path segment> (<METHODS>)`; a child's
 * segment continues its parent's path. A format change breaks this parse
 * loudly rather than letting an undocumented route through.
 */
function registeredRoutes(app: FastifyInstance): string[] {
  const routes: string[] = [];
  const stack: { depth: number; path: string }[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    if (!line.trim()) continue;
    const match = /^([│ ]*)[├└]── (\S+) \(([A-Z, ]+)\)$/.exec(line);
    if (!match) throw new Error(`unrecognised printRoutes line: ${line}`);
    const depth = match[1].length / 4;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const full = (stack.length ? stack[stack.length - 1].path : "") + match[2];
    stack.push({ depth, path: full });
    for (const method of match[3].split(",").map((m) => m.trim())) {
      // Fastify adds HEAD to every GET automatically; it is not a separate contract.
      if (method !== "HEAD") routes.push(`${method} ${full}`);
    }
  }
  return routes.sort();
}

describe("OpenAPI contract", () => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it("documents exactly the routes the API registers, no more and no fewer", async () => {
    const app = await buildTestApp({ db: {} as Database });
    apps.push(app);
    await app.ready();

    expect(documentedRoutes().sort()).toEqual(registeredRoutes(app));
  });

  it("describes every operation's responses, including the shared error bodies", () => {
    const document = generateOpenApiDocument();
    expect(document.openapi).toMatch(/^3\./);
    const operations = Object.values(document.paths).flatMap((item) => Object.values(item ?? {}));
    expect(operations.length).toBe(documentedRoutes().length);
    for (const operation of operations) {
      expect(Object.keys(operation.responses ?? {}).length).toBeGreaterThan(0);
    }
    expect(Object.keys(document.components?.schemas ?? {})).toEqual(
      expect.arrayContaining(["Card", "CardList", "Session", "AuthError", "InternalError"]),
    );
  });

  it("documents the rate-limit 429 on every limited route and never on /health", () => {
    const document = generateOpenApiDocument();
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item ?? {})) {
        const responses = (operation as { responses: Record<string, unknown> }).responses;
        if (path === "/health") {
          expect(responses, `${method} ${path}`).not.toHaveProperty("429");
        } else {
          expect(responses, `${method} ${path}`).toHaveProperty("429");
        }
      }
    }
    expect(Object.keys(document.components?.schemas ?? {})).toContain("RateLimited");
  });

  it("uses OpenAPI path templates for path parameters", () => {
    const document = generateOpenApiDocument();
    expect(Object.keys(document.paths)).toContain("/cards/{cardId}");
    expect(Object.keys(document.paths).some((p) => p.includes(":"))).toBe(false);
  });

  it("renders byte-identical output on every run", () => {
    expect(renderOpenApiDocument()).toBe(renderOpenApiDocument());
  });
});

describe("OpenAPI drift check", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openapi-"));
  const file = path.join(dir, "openapi.json");
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("passes when the committed document matches the generated one", () => {
    writeOpenApiFile(file);
    expect(checkOpenApiFile(file)).toEqual({ ok: true });
  });

  it("fails when the committed document is stale", () => {
    writeOpenApiFile(file);
    const stale = JSON.parse(fs.readFileSync(file, "utf8")) as { paths: Record<string, unknown> };
    delete stale.paths["/health"];
    fs.writeFileSync(file, JSON.stringify(stale, null, 2) + "\n");
    expect(checkOpenApiFile(file)).toMatchObject({ ok: false, reason: "drift" });
  });

  it("fails when the committed document is missing", () => {
    expect(checkOpenApiFile(path.join(dir, "absent.json"))).toMatchObject({ ok: false, reason: "missing" });
  });
});
