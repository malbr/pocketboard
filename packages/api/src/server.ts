import { loadRepositoryEnvFile } from "./config/repository-root";
import { createProductionApp } from "./composition-root";

// npm starts this from `packages/api`, so the root `.env` has to be loaded by
// path rather than left to the shell. Real environment variables still win.
loadRepositoryEnvFile();

const port = Number(process.env.API_PORT ?? 3000);

// A configuration failure must crash the process, not start an unprotected API.
const { app } = await createProductionApp(process.env);

app.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
  app.log.fatal({ err: error }, "API failed to start");
  process.exit(1);
});
