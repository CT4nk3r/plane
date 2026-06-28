/**
 * Durable job queue backing the webhook -> worker handoff. This mirrors how
 * Plane processes webhooks asynchronously (Celery `webhook_send_task` with
 * retries/backoff): the HTTP handler enqueues, a worker drains the queue with
 * bounded retries. Two implementations: Postgres (`FOR UPDATE SKIP LOCKED`) and
 * in-memory (tests).
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { SyncJob } from "./types";

export interface EnqueueInput {
  dedupeKey: string;
  eventType: string;
  payload: unknown;
}

export interface FailInput {
  error: string;
  nextAttemptAt: Date;
  exhausted: boolean;
}

export interface JobQueue {
  enqueue(input: EnqueueInput): Promise<{ id: string | null; enqueued: boolean }>;
  /** Atomically claim the next due job, marking it `processing` and bumping `attempts`. */
  claimNext(): Promise<SyncJob | null>;
  complete(id: string): Promise<void>;
  fail(id: string, input: FailInput): Promise<void>;
}

const ACTIVE_STATUSES = ["queued", "processing", "completed"];

function rowToJob(row: Record<string, unknown>): SyncJob {
  return {
    id: String(row.id),
    dedupe_key: String(row.dedupe_key),
    event_type: String(row.event_type),
    payload: row.payload,
    status: row.status as SyncJob["status"],
    attempts: Number(row.attempts),
    last_error: (row.last_error as string | null) ?? null,
    next_attempt_at: new Date(row.next_attempt_at as string).toISOString(),
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

export function createPgJobQueue(pool: Pool): JobQueue {
  return {
    async enqueue(input) {
      const inserted = await pool.query(
        `INSERT INTO sync_jobs (dedupe_key, event_type, payload)
         SELECT $1, $2, $3::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM sync_jobs WHERE dedupe_key = $1 AND status = ANY($4)
         )
         RETURNING id`,
        [input.dedupeKey, input.eventType, JSON.stringify(input.payload), ACTIVE_STATUSES],
      );
      if (inserted.rows[0]) {
        return { id: String(inserted.rows[0].id), enqueued: true };
      }
      const existing = await pool.query(
        `SELECT id FROM sync_jobs WHERE dedupe_key = $1 AND status = ANY($2) ORDER BY created_at LIMIT 1`,
        [input.dedupeKey, ACTIVE_STATUSES],
      );
      return { id: existing.rows[0] ? String(existing.rows[0].id) : null, enqueued: false };
    },

    async claimNext() {
      const res = await pool.query(
        `UPDATE sync_jobs SET status = 'processing', attempts = attempts + 1, updated_at = now()
         WHERE id = (
           SELECT id FROM sync_jobs
           WHERE status = 'queued' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`,
      );
      return res.rows[0] ? rowToJob(res.rows[0]) : null;
    },

    async complete(id) {
      await pool.query(
        `UPDATE sync_jobs SET status = 'completed', last_error = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
    },

    async fail(id, input) {
      await pool.query(
        `UPDATE sync_jobs
         SET status = $2, last_error = $3, next_attempt_at = $4, updated_at = now()
         WHERE id = $1`,
        [id, input.exhausted ? "failed" : "queued", input.error, input.nextAttemptAt.toISOString()],
      );
    },
  };
}

export function createInMemoryJobQueue(): JobQueue {
  const jobs: SyncJob[] = [];

  return {
    async enqueue(input) {
      const active = jobs.find(
        (job) => job.dedupe_key === input.dedupeKey && ACTIVE_STATUSES.includes(job.status),
      );
      if (active) {
        return { id: active.id, enqueued: false };
      }
      const now = new Date().toISOString();
      const job: SyncJob = {
        id: randomUUID(),
        dedupe_key: input.dedupeKey,
        event_type: input.eventType,
        payload: input.payload,
        status: "queued",
        attempts: 0,
        last_error: null,
        next_attempt_at: now,
        created_at: now,
        updated_at: now,
      };
      jobs.push(job);
      return { id: job.id, enqueued: true };
    },

    async claimNext() {
      const now = Date.now();
      const job = jobs.find((j) => j.status === "queued" && new Date(j.next_attempt_at).getTime() <= now);
      if (!job) return null;
      job.status = "processing";
      job.attempts += 1;
      job.updated_at = new Date().toISOString();
      return { ...job };
    },

    async complete(id) {
      const job = jobs.find((j) => j.id === id);
      if (job) {
        job.status = "completed";
        job.last_error = null;
        job.updated_at = new Date().toISOString();
      }
    },

    async fail(id, input) {
      const job = jobs.find((j) => j.id === id);
      if (job) {
        job.status = input.exhausted ? "failed" : "queued";
        job.last_error = input.error;
        job.next_attempt_at = input.nextAttemptAt.toISOString();
        job.updated_at = new Date().toISOString();
      }
    },
  };
}
