/**
 * POST /webhooks/plane — receive Plane's outbound webhooks and enqueue reverse
 * (Plane -> external) sync jobs.
 *
 * Auth is Plane's native HMAC: `X-Plane-Signature` is the hex HMAC-SHA256 of the
 * exact request body using the webhook's `secret_key`. We verify against the raw
 * bytes captured by the body parser (re-serializing the parsed JSON would not be
 * byte-identical and would break the signature), in constant time.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import type { Config } from "../config";
import { WebhookParseError } from "../connectors/types";
import { parsePlaneWebhook } from "../parsers/planeWebhook";
import type { JobQueue } from "../queue";
import type { Logger } from "../logger";

export interface PlaneWebhookRouterDeps {
  config: Config;
  queue: JobQueue;
  logger: Logger;
}

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

function verifySignature(raw: Buffer | undefined, signature: string | undefined, secret: string): boolean {
  if (!raw || !signature) return false;
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createPlaneWebhookRouter(deps: PlaneWebhookRouterDeps): Router {
  const { config, queue, logger } = deps;
  const router = Router();
  const secret = config.reverse.planeWebhookSecret ?? "";

  router.post("/", async (req: Request, res: Response): Promise<void> => {
    const raw = (req as RawBodyRequest).rawBody;
    const signature = req.header("x-plane-signature");
    if (!secret || !verifySignature(raw, signature, secret)) {
      logger.warn("plane_webhook.unauthorized", { ip: req.ip });
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const event = parsePlaneWebhook(req.body);
      const dedupeKey = `plane:issue:${event.issueId}:${event.updatedAt}`;
      const { id, enqueued } = await queue.enqueue({
        dedupeKey,
        eventType: `plane.issue.${event.action}`,
        payload: { direction: "reverse", event },
      });
      logger.info("plane_webhook.received", {
        issueId: event.issueId,
        action: event.action,
        externalId: event.externalId,
        enqueued,
        jobId: id,
      });
      res.status(202).json({ status: enqueued ? "queued" : "duplicate", jobId: id, issueId: event.issueId });
    } catch (error) {
      if (error instanceof WebhookParseError) {
        if (error.code === "unsupported_event") {
          res.status(200).json({ status: "ignored", reason: error.message });
          return;
        }
        res.status(400).json({ error: error.message });
        return;
      }
      logger.error("plane_webhook.error", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}
