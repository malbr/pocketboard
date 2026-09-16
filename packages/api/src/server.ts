import { createProductionApp } from "./composition-root";

const port = Number(process.env.API_PORT ?? 3000);

// A configuration failure must crash the process, not start an unprotected API.
const { app } = await createProductionApp(process.env);

app.listen({ port, host: "0.0.0.0" }).catch((error: unknown) => {
  app.log.fatal({ err: error }, "API failed to start");
  process.exit(1);
});
