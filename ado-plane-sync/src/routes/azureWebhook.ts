/**
 * POST /webhooks/azure-devops — authenticate, parse, and enqueue.
 *
 * Auth accepts either HTTP Basic (the password must equal ADO_WEBHOOK_SECRET)
 * or an `X-Webhook-Secret` header, compared in constant time. Both are
 * supported because ADO Service Hooks can send either.
 */

import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "../config";
import type { JobQueue } from "../queue";
import type { Logger } from "../logger";
import { parseWorkItemEvent, WebhookParseError } from "../parsers/azureDevOpsWebhook";

export interface WebhookRouterDeps {
  config: Config;
  queue: JobQueue;
  logger: Logger;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function extractBasicPassword(header: string | undefined): string | undefined {
  if (!header || !header.toLowerCase().startsWith("basic ")) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    return sep === -1 ? decoded : decoded.slice(sep + 1);
  } catch {
    return undefined;
  }
}

function isAuthorized(req: Request, secret: string): boolean {
  const headerSecret = req.header("x-webhook-secret");
  if (typeof headerSecret === "string" && safeEqual(headerSecret, secret)) {
    return true;
  }
  const basicPassword = extractBasicPassword(req.header("authorization"));
  if (typeof basicPassword === "string" && safeEqual(basicPassword, secret)) {
    return true;
  }
  return false;
}

export function createAzureWebhookRouter(deps: WebhookRouterDeps): Router {
  const { config, queue, logger } = deps;
  const router = Router();

  const auth = (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthorized(req, config.ado.webhookSecret)) {
      next();
      return;
    }
    logger.warn("webhook.unauthorized", { ip: req.ip });
    res.status(401).json({ error: "unauthorized" });
  };

  router.post("/", auth, async (req: Request, res: Response): Promise<void> => {
    try {
      const event = parseWorkItemEvent(req.body, {
        org: config.ado.org,
        project: config.ado.project,
      });
      const dedupeKey = `${event.org}:${event.project}:${event.workItemId}:${event.rev}`;
      const { id, enqueued } = await queue.enqueue({
        dedupeKey,
        eventType: event.eventType,
        payload: event,
      });
      logger.info("webhook.received", {
        eventType: event.eventType,
        workItemId: event.workItemId,
        rev: event.rev,
        enqueued,
        jobId: id,
      });
      res.status(202).json({
        status: enqueued ? "queued" : "duplicate",
        jobId: id,
        workItemId: event.workItemId,
      });
    } catch (error) {
      if (error instanceof WebhookParseError) {
        if (error.code === "unsupported_event") {
          res.status(200).json({ status: "ignored", reason: error.message });
          return;
        }
        res.status(400).json({ error: error.message });
        return;
      }
      logger.error("webhook.error", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}
