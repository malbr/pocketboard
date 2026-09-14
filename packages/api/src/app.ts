import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/client";
import { registerHealthRoutes } from "./routes/health";
import { registerCardRoutes } from "./routes/cards";

export function buildApp(db: Database): FastifyInstance {
  const app = Fastify({ logger: false });
  registerHealthRoutes(app);
  registerCardRoutes(app, db);
  return app;
}
