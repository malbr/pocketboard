import type { FastifyInstance } from "fastify";
import type { HealthProbe } from "../health/database-probe";
import { unlimitedRoute } from "../rate-limit";

export function registerHealthRoutes(app: FastifyInstance, databaseReady: HealthProbe): void {
  app.get("/health", { config: unlimitedRoute }, async (_request, reply) => {
    if (await databaseReady()) {
      return { status: "ok" };
    }
    // The cause is logged by the probe; callers only learn that it failed.
    return reply.code(503).send({ status: "unavailable" });
  });
}
