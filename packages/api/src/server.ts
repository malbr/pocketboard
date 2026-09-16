import { buildApp } from "./app";
import { createDbClient } from "./db/client";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://pocketboard:pocketboard@localhost:5432/pocketboard";
const port = Number(process.env.API_PORT ?? 3000);

const { db } = createDbClient(connectionString);
const app = buildApp(db);

app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    console.log(`API listening on port ${port}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
