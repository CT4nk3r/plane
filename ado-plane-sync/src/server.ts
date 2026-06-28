/**
 * Express application factory. Dependencies are injected so tests can supply an
 * in-memory queue, a connector registry, and a fake logger. `createApp` does not
 * call `listen` — that is the entrypoint's job.
 */

import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Config } from "./config";
import type { ConnectorRegistry } from "./connectors/registry";
import type { JobQueue } from "./queue";
import type { Logger } from "./logger";
import { createWebhookRouter } from "./routes/webhook";
import { createPlaneWebhookRouter } from "./routes/planeWebhook";

export interface AppDeps {
  config: Config;
  registry: ConnectorRegistry;
  queue: JobQueue;
  logger: Logger;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();

  app.use(helmet());
  app.use(cors());
  // Capture the raw body so the Plane webhook route can verify the HMAC
  // signature against the exact bytes Plane signed.
  app.use(
    express.json({
      limit: "5mb",
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      providers: deps.registry.all.map((connector) => connector.provider),
      reverseSync: deps.config.reverse.enabled,
    });
  });

  // Mounted before the generic ":provider" router so it isn't shadowed.
  if (deps.config.reverse.enabled) {
    app.use("/webhooks/plane", createPlaneWebhookRouter(deps));
  }
  app.use("/webhooks", createWebhookRouter(deps));

  return app;
}
