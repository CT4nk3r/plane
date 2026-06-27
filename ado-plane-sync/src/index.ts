/**
 * Entrypoint: load config, prepare the store/queue (Postgres when DATABASE_URL
 * is set, in-memory otherwise), bootstrap the connection, then start the HTTP
 * server and the background worker. Wires graceful shutdown.
 */

import type { Pool } from "pg";
import { createAzureDevOpsClient } from "./clients/azureDevOps";
import { createPlaneClient } from "./clients/plane";
import { loadConfig } from "./config";
import { bootstrapConnection } from "./connection";
import { createInMemorySyncStore, createPgSyncStore, createPool, ensureSchema } from "./db";
import { createLogger } from "./logger";
import { createInMemoryJobQueue, createPgJobQueue } from "./queue";
import { createApp } from "./server";
import { createWorker } from "./worker";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { svc: "ado-plane-sync" });

  let pool: Pool | null = null;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl);
    await ensureSchema(pool);
    logger.info("db.ready");
  } else {
    logger.warn("db.in_memory", {
      message: "DATABASE_URL not set; using a non-durable in-memory store",
    });
  }

  const store = pool ? createPgSyncStore(pool) : createInMemorySyncStore();
  const queue = pool ? createPgJobQueue(pool) : createInMemoryJobQueue();
  const plane = createPlaneClient(config, logger);
  const ado = createAzureDevOpsClient(config, logger);

  const connection = await bootstrapConnection(config, store, plane, logger);

  const app = createApp({ config, queue, logger });
  const server = app.listen(config.port, () => {
    logger.info("server.listening", { port: config.port });
  });

  let worker: { stop: () => void } | undefined;
  if (config.worker.enabled) {
    worker = createWorker({
      queue,
      maxRetries: config.worker.maxRetries,
      logger,
      syncDeps: { config, connection, ado, plane, store, logger },
    }).start();
  }

  const shutdown = (signal: string): void => {
    logger.info("shutdown", { signal });
    worker?.stop();
    server.close(() => {
      void store.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
