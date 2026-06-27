/**
 * Background worker. Drains the sync_jobs queue and runs `syncWorkItem` per job,
 * with bounded exponential-backoff retries — mirroring Plane's
 * `webhook_send_task` (autoretry, max_retries, backoff, then give up).
 */

import type { JobQueue } from "./queue";
import type { Logger } from "./logger";
import type { SyncDeps, SyncOutcome } from "./sync/workItemSync";
import { syncWorkItem } from "./sync/workItemSync";
import type { ParsedWebhookEvent, SyncJob } from "./types";

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;

export function computeBackoffMs(attempt: number): number {
  const exp = BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(BACKOFF_MAX_MS, exp);
}

export interface WorkerDeps {
  queue: JobQueue;
  syncDeps: SyncDeps;
  maxRetries: number;
  logger: Logger;
}

export type ProcessResult =
  | { job: SyncJob; outcome: SyncOutcome }
  | { job: SyncJob; error: string };

export interface Worker {
  /** Claim and process at most one due job. Returns null when the queue is empty. */
  processOnce(): Promise<ProcessResult | null>;
  /** Start the polling loop. Returns a stopper. */
  start(pollIntervalMs?: number): { stop: () => void };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createWorker(deps: WorkerDeps): Worker {
  const { queue, syncDeps, maxRetries, logger } = deps;

  async function processOnce(): Promise<ProcessResult | null> {
    const job = await queue.claimNext();
    if (!job) return null;

    try {
      const event = job.payload as ParsedWebhookEvent;
      const outcome = await syncWorkItem(event, syncDeps);
      await queue.complete(job.id);
      return { job, outcome };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = job.attempts >= maxRetries;
      const nextAttemptAt = new Date(Date.now() + computeBackoffMs(job.attempts));
      await queue.fail(job.id, { error: message, nextAttemptAt, exhausted });
      logger.error("worker.job.failed", {
        jobId: job.id,
        attempts: job.attempts,
        exhausted,
        error: message,
      });
      return { job, error: message };
    }
  }

  function start(pollIntervalMs = 1_000): { stop: () => void } {
    let running = true;
    const loop = async (): Promise<void> => {
      logger.info("worker.started", { pollIntervalMs, maxRetries });
      while (running) {
        try {
          const result = await processOnce();
          if (!result) {
            await sleep(pollIntervalMs);
          }
        } catch (error) {
          logger.error("worker.loop.error", {
            error: error instanceof Error ? error.message : String(error),
          });
          await sleep(pollIntervalMs);
        }
      }
      logger.info("worker.stopped");
    };
    void loop();
    return {
      stop: () => {
        running = false;
      },
    };
  }

  return { processOnce, start };
}
