import type { FastifyInstance } from "fastify";
import { unlimitedRoute } from "../rate-limit";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", { config: unlimitedRoute }, async () => ({ status: "ok" }));
}
