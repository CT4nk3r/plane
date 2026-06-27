/**
 * Connector registry — the single place that knows which providers exist.
 * Indexed by webhook slug (for routing `POST /webhooks/:slug`) and by provider
 * (for the worker to resolve the right connector from a queued job).
 *
 * Adding a provider is a one-line change here plus a new connector module.
 */

import type { Config } from "../config";
import type { Logger } from "../logger";
import { createAzureDevOpsConnector } from "./azureDevOps";
import type { Connector } from "./types";

export interface ConnectorRegistry {
  all: Connector[];
  bySlug: Map<string, Connector>;
  byProvider: Map<string, Connector>;
}

export function buildConnectorRegistry(config: Config, logger: Logger): ConnectorRegistry {
  // Register additional providers here, e.g.:
  //   createGithubConnector(config, logger), createJiraConnector(config, logger)
  const all: Connector[] = [createAzureDevOpsConnector(config, logger)];

  const bySlug = new Map<string, Connector>();
  const byProvider = new Map<string, Connector>();
  for (const connector of all) {
    bySlug.set(connector.webhookSlug, connector);
    byProvider.set(connector.provider, connector);
  }

  return { all, bySlug, byProvider };
}
