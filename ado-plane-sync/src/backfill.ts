/**
 * One-time scoped backfill of *existing* entities (vs. webhook-driven sync of
 * changes). The connector enumerates entities for a scope (e.g. "assigned-to-me"),
 * then each flows through the same sync engine — so dynamic states, cycles,
 * labels, idempotency, etc. all apply. Runs with bounded concurrency and returns
 * a summary.
 */

import type { Connector } from "./connectors/types";
import type { SyncDeps } from "./sync/syncEngine";
import { syncEntity } from "./sync/syncEngine";

export interface BackfillOptions {
  scope: string;
  /** Max entities to process (safety cap). */
  limit: number;
  /** How many to sync in parallel (mind Plane's API rate limit). */
  concurrency: number;
}

export interface BackfillSummary {
  scope: string;
  found: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  truncated: boolean;
  errors: { externalId: string; error: string }[];
}

export async function runBackfill(
  connector: Connector,
  deps: SyncDeps,
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const { logger } = deps;
  const all = await connector.listEntities(options.scope, deps.connection);
  const truncated = all.length > options.limit;
  const events = all.slice(0, options.limit);

  const summary: BackfillSummary = {
    scope: options.scope,
    found: all.length,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    truncated,
    errors: [],
  };

  logger.info("backfill.found", { scope: options.scope, found: all.length, willProcess: events.length, truncated });

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(options.concurrency, events.length || 1));

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= events.length) return;
      const event = events[index];
      try {
        const outcome = await syncEntity(connector, event, deps);
        summary.processed += 1;
        if (outcome.action === "created") summary.created += 1;
        else if (outcome.action === "updated") summary.updated += 1;
        else summary.skipped += 1;
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({
          externalId: event.externalId,
          error: error instanceof Error ? error.message : String(error),
        });
        logger.warn("backfill.item_failed", {
          externalId: event.externalId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return summary;
}
