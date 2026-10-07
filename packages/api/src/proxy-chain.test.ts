import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { repositoryRoot } from "./config/repository-root";
import type { Database } from "./db/client";
import { AUTH_ROUTE_LIMIT } from "./rate-limit";
import { buildTestApp } from "./testing/build-test-app";

/**
 * The production chain, hop by hop (issue #51):
 *
 *   client ─TLS─▶ host Caddy ─▶ 127.0.0.1:8080 ─▶ web nginx (172.31.250.10) ─▶ api
 *
 * Caddy connects to the loopback-published port, so the peer nginx sees is the
 * host side of the `frontend` bridge, not the client. These tests rebuild the
 * headers each hop writes and feed them to the API with nginx as the socket
 * peer, using the trust list and addresses read from the real deployment files,
 * so a change to Compose or nginx that breaks client identity fails here.
 */
const compose = fs.readFileSync(path.join(repositoryRoot, "compose.production.yml"), "utf8");
const nginxConfig = fs.readFileSync(
  path.join(repositoryRoot, "packages/web/nginx/default.conf"),
  "utf8",
);

const FRONTEND_SUBNET = "172.31.250.0/24";
const NGINX_ADDRESS = "172.31.250.10";
/**
 * Docker's default IPAM gives a network with a configured subnet and no
 * configured gateway the subnet's first host address as its bridge gateway.
 * Traffic the host sends into the bridge — docker-proxy for a published port,
 * or the loopback MASQUERADE rule without it — leaves from that address.
 */
const BRIDGE_GATEWAY = "172.31.250.1";

const productionTrustedProxies = (/^\s*TRUSTED_PROXY_IPS:\s*"?([^"\n]+)"?\s*$/m.exec(compose)?.[1] ?? "")
  .split(",")
  .map((entry) => entry.trim());

/** Caddy's documented default: incoming X-Forwarded-* from an untrusted client is discarded. */
function caddy(clientIp: string): Record<string, string> {
  return { "x-forwarded-for": clientIp, "x-forwarded-proto": "https" };
}

/**
 * Caddy with `trusted_proxies` covering the client, which appends instead. Not
 * the documented production setting, but a client-supplied value must still
 * not decide the identity if the host config ever changes this way.
 */
function caddyAppending(clientIp: string, incoming: string): Record<string, string> {
  return { "x-forwarded-for": `${incoming}, ${clientIp}`, "x-forwarded-proto": "https" };
}

/** nginx's `$proxy_add_x_forwarded_for`: the incoming header plus its own peer. */
function nginx(headers: Record<string, string>, peer = BRIDGE_GATEWAY): Record<string, string> {
  const incoming = headers["x-forwarded-for"];
  return {
    ...headers,
    "x-forwarded-for": incoming ? `${incoming}, ${peer}` : peer,
  };
}

const noDatabase = {} as Database;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function productionApi() {
  const app = await buildTestApp({
    db: noDatabase,
    authConfig: { trustedProxies: productionTrustedProxies },
  });
  apps.push(app);
  const seen: { ip: string; protocol: string }[] = [];
  app.addHook("onRequest", async (request) => {
    seen.push({ ip: request.ip, protocol: request.protocol });
  });
  return { app, seen };
}

function send(app: FastifyInstance, headers: Record<string, string>, remoteAddress = NGINX_ADDRESS) {
  return app.inject({ method: "GET", url: "/auth/github", headers, remoteAddress });
}

describe("the modelled chain matches the deployment files", () => {
  it("fixes nginx's address and the frontend subnet in Compose", () => {
    expect(compose).toMatch(new RegExp(`subnet:\\s*${FRONTEND_SUBNET.replace(/\./g, "\\.")}\\s*$`, "m"));
    expect(compose).toMatch(new RegExp(`ipv4_address:\\s*${NGINX_ADDRESS.replace(/\./g, "\\.")}\\s*$`, "m"));
    // A configured gateway would replace the default this file relies on.
    expect(compose).not.toMatch(/^\s*gateway:/m);
  });

  it("has nginx append its peer to X-Forwarded-For, as modelled", () => {
    expect(nginxConfig).toMatch(
      /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/,
    );
  });

  it("trusts exactly nginx and the bridge gateway, nothing wider", () => {
    expect([...productionTrustedProxies].sort()).toEqual([BRIDGE_GATEWAY, NGINX_ADDRESS].sort());
  });
});

describe("client identity behind Caddy → nginx → API", () => {
  it("gives two different clients two different request.ip values", async () => {
    const { app, seen } = await productionApi();

    await send(app, nginx(caddy("203.0.113.10")));
    await send(app, nginx(caddy("198.51.100.20")));

    expect(seen.map((s) => s.ip)).toEqual(["203.0.113.10", "198.51.100.20"]);
  });

  it("gives each client its own OAuth budget", async () => {
    const { app } = await productionApi();

    const first = [];
    for (let i = 0; i <= AUTH_ROUTE_LIMIT.max; i += 1) {
      first.push(await send(app, nginx(caddy("203.0.113.10"))));
    }
    const other = await send(app, nginx(caddy("198.51.100.20")));

    expect(first[AUTH_ROUTE_LIMIT.max].statusCode).toBe(429);
    // Before #51 every visitor was the bridge gateway, so this was 429 too.
    expect(other.statusCode).toBe(302);
  });

  it("still believes the protocol Caddy reports through nginx", async () => {
    const { app, seen } = await productionApi();

    await send(app, nginx(caddy("203.0.113.10")));

    expect(seen[0].protocol).toBe("https");
  });

  it("ignores a forged X-Forwarded-For smuggled through the chain", async () => {
    const { app, seen } = await productionApi();
    const forged = "192.0.2.1";

    // Caddy's default discards the forged value; an appending Caddy keeps it
    // leftmost, where the walk from the right never reaches it.
    await send(app, nginx(caddy("203.0.113.10")));
    await send(app, nginx(caddyAppending("203.0.113.10", forged)));
    await send(app, nginx(caddyAppending("203.0.113.10", `${forged}, ${BRIDGE_GATEWAY}`)));

    expect(seen.map((s) => s.ip)).toEqual(["203.0.113.10", "203.0.113.10", "203.0.113.10"]);
  });

  it("cannot reset a client's budget by rotating a smuggled X-Forwarded-For", async () => {
    const { app } = await productionApi();

    const responses = [];
    for (let i = 0; i <= AUTH_ROUTE_LIMIT.max; i += 1) {
      responses.push(await send(app, nginx(caddyAppending("203.0.113.10", `192.0.2.${i + 1}`))));
    }

    expect(responses[AUTH_ROUTE_LIMIT.max].statusCode).toBe(429);
  });

  it.each([
    ["an outside address", "203.0.113.66"],
    ["another frontend-network address", "172.31.250.20"],
  ])("ignores X-Forwarded-For from a direct caller at %s", async (_label, peer) => {
    const { app, seen } = await productionApi();

    const responses = [];
    for (let i = 0; i <= AUTH_ROUTE_LIMIT.max; i += 1) {
      responses.push(
        await send(
          app,
          { "x-forwarded-for": `192.0.2.${i + 1}, ${BRIDGE_GATEWAY}`, "x-forwarded-proto": "https" },
          peer,
        ),
      );
    }

    expect(new Set(seen.map((s) => s.ip))).toEqual(new Set([peer]));
    expect(seen.every((s) => s.protocol === "http")).toBe(true);
    expect(responses[AUTH_ROUTE_LIMIT.max].statusCode).toBe(429);
  });

  it("identifies a host-side request with no X-Forwarded-For as the bridge gateway", async () => {
    const { app, seen } = await productionApi();

    // The deploy script's own `127.0.0.1:8080/api/health` check bypasses Caddy.
    await send(app, nginx({}));

    expect(seen[0].ip).toBe(BRIDGE_GATEWAY);
  });
});
