/**
 * Backfill CLI: pull existing ADO work items for a scope into Plane.
 *
 *   node dist/cli/backfill.js <scope>
 *   pnpm backfill <scope>
 *   docker compose run --rm ado-plane-sync node dist/cli/backfill.js assigned-to-me
 *
 * Scopes: assigned-to-me | assigned-to:<user> | created-by-me | created-by:<user>
 *         | active | recent[:days] | sprint:<name> | area:<name> | all | query:<WIQL>
 *
 * Env: BACKFILL_LIMIT (default 500), BACKFILL_CONCURRENCY (default 3).
 * Use the same DATABASE_URL as the running service so mappings are shared.
 */

import type { Pool } from "pg";
import { createPlaneClient } from "../clients/plane";
import { loadConfig } from "../config";
import { bootstrapConnection } from "../connection";
import { BACKFILL_PRESETS } from "../connectors/azureDevOpsBackfill";
import { buildConnectorRegistry } from "../connectors/registry";
import { runBackfill } from "../backfill";
import { createInMemorySyncStore, createPgSyncStore, createPool, ensureSchema } from "../db";
import { createLogger } from "../logger";

async function main(): Promise<void> {
  const scope = process.argv[2] ?? process.env.BACKFILL_SCOPE;
  if (!scope || scope === "--help" || scope === "-h") {
    process.stderr.write(`Usage: backfill <scope>\n\nScopes:\n  ${BACKFILL_PRESETS.join("\n  ")}\n`);
    process.exit(scope ? 0 : 2);
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel, { svc: "ado-plane-sync", mode: "backfill" });

  let pool: Pool | null = null;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl);
    await ensureSchema(pool);
  } else {
    logger.warn("backfill.in_memory", {
      message: "DATABASE_URL not set; mappings won't be shared with the running service",
    });
  }

  const store = pool ? createPgSyncStore(pool) : createInMemorySyncStore();
  const plane = createPlaneClient(config, logger);
  const registry = buildConnectorRegistry(config, logger);
  const connection = await bootstrapConnection(config, store, plane, logger);

  const connector = registry.byProvider.get(config.service);
  if (!connector) {
    logger.error("backfill.no_connector", { provider: config.service });
    await store.close();
    process.exit(1);
  }

  const limit = Number(process.env.BACKFILL_LIMIT ?? 500);
  const concurrency = Number(process.env.BACKFILL_CONCURRENCY ?? 3);

  logger.info("backfill.start", { scope, limit, concurrency });
  const summary = await runBackfill(connector, { config, connection, plane, store, logger }, {
    scope,
    limit,
    concurrency,
  });
  logger.info("backfill.done", { ...summary, errors: summary.errors.length });

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  await store.close();
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
