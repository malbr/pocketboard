import net from "node:net";
import postgres from "postgres";
import type { DatabaseCheck } from "./database-probe";

export interface PostgresHealthCheckOptions {
  /** Driver deadline for opening a connection. */
  connectTimeoutSeconds?: number;
  /** Server-side deadline for the health query. */
  statementTimeoutMs?: number;
}

/** The subset of the driver's parsed options its `socket` factory receives. */
interface SocketOptions {
  host: string[];
  port: number[];
  path?: string | false;
}

/**
 * The `select 1` behind `GET /health`, on its own single connection so a
 * stalled database can never tie up the application's pool.
 *
 * When the probe aborts a check, that connection's socket is destroyed, and the
 * check settles only once the socket has closed. The driver's own `end()` only
 * half-closes (`socket.end()`), which leaves the socket open for as long as a
 * stalled peer never closes its side, so this module opens the socket itself
 * through the driver's `socket` option and keeps ownership until it closes. The
 * next check opens a fresh connection, so at most one health connection is
 * open at any time.
 */
export function createPostgresHealthCheck(
  connectionString: string,
  { connectTimeoutSeconds = 2, statementTimeoutMs = 2_000 }: PostgresHealthCheckOptions = {},
): { check: DatabaseCheck; close: () => Promise<void> } {
  const open = () => {
    const sockets = new Set<net.Socket>();
    let destroyed = false;
    const sql = postgres(connectionString, {
      max: 1,
      connect_timeout: connectTimeoutSeconds,
      idle_timeout: 60,
      connection: { application_name: "pocketboard-health", statement_timeout: statementTimeoutMs },
      // Not in the driver's type definitions, but part of its options: a
      // factory for the connection's socket, used instead of its own.
      ...({
        socket: ({ host, port, path }: SocketOptions) => {
          // A destroyed client must not reconnect behind the probe's back.
          if (destroyed) throw new Error("health connection destroyed");
          const socket = path ? net.connect(path) : net.connect(port[0], host[0]);
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
          return socket;
        },
      } as object),
    });
    const destroy = async () => {
      destroyed = true;
      const closed = [...sockets].map((socket) => new Promise((resolve) => socket.once("close", resolve)));
      void sql.end({ timeout: 0 }).catch(() => {});
      for (const socket of sockets) socket.destroy();
      await Promise.all(closed);
    };
    return { sql, destroy };
  };
  let client = open();

  return {
    async check(signal) {
      const current = client;
      let closing: Promise<void> | undefined;
      const abort = () => {
        if (client === current) client = open();
        closing = current.destroy();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await current.sql`select 1`;
      } finally {
        signal.removeEventListener("abort", abort);
        // The probe owns an aborted check until its socket has really closed.
        await closing;
      }
    },
    close: () => client.destroy(),
  };
}
