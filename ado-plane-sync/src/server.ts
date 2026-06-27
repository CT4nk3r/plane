/**
 * Express application factory. Dependencies are injected so tests can supply an
 * in-memory queue and a fake logger. `createApp` does not call `listen` — that
 * is the entrypoint's job.
 */

import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Config } from "./config";
import type { JobQueue } from "./queue";
import type { Logger } from "./logger";
import { createAzureWebhookRouter } from "./routes/azureWebhook";

export interface AppDeps {
  config: Config;
  queue: JobQueue;
  logger: Logger;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: deps.config.service });
  });

  app.use("/webhooks/azure-devops", createAzureWebhookRouter(deps));

  return app;
}
