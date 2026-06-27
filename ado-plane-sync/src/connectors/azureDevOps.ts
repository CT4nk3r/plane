/**
 * Azure DevOps connector. Implements the generic `Connector` by composing the
 * ADO-specific parser, REST client, and work item mapper.
 */

import { createAzureDevOpsClient } from "../clients/azureDevOps";
import type { AzureDevOpsClient } from "../clients/azureDevOps";
import type { Config } from "../config";
import type { Logger } from "../logger";
import { mapWorkItem } from "../mappers/workItemMapper";
import { parseWorkItemEvent } from "../parsers/azureDevOpsWebhook";
import type { ConnectionContext } from "../types";
import type { Connector, MappedEntity, NormalizedEvent } from "./types";

export const AZURE_DEVOPS_WEBHOOK_SLUG = "azure-devops";

export function createAzureDevOpsConnector(config: Config, logger: Logger): Connector {
  const ado: AzureDevOpsClient = createAzureDevOpsClient(config, logger);
  const provider = config.service;

  return {
    provider,
    webhookSlug: AZURE_DEVOPS_WEBHOOK_SLUG,

    parseWebhook(body, fallback): NormalizedEvent {
      const event = parseWorkItemEvent(body, fallback);
      return {
        provider,
        eventType: event.eventType,
        externalId: String(event.workItemId),
        externalRev: event.rev,
        org: event.org,
        project: event.project,
        raw: body,
      };
    },

    async fetchEntity(event: NormalizedEvent, ctx: ConnectionContext): Promise<MappedEntity> {
      const workItem = await ado.getWorkItem(Number(event.externalId));
      const mapped = mapWorkItem(workItem, {
        stateMap: ctx.stateMap,
        externalSource: ctx.externalSource,
      });
      return {
        name: mapped.name,
        descriptionHtml: mapped.descriptionHtml,
        stateName: mapped.stateName,
        tags: mapped.tags,
        assignee: mapped.assignee,
        externalId: mapped.externalId,
        externalSource: mapped.externalSource,
        externalUrl: mapped.url,
        externalRev: workItem.rev ?? event.externalRev,
      };
    },

    async addBacklink(event: NormalizedEvent, planeIssueUrl: string): Promise<number | null> {
      return ado.addBacklinkComment(
        Number(event.externalId),
        `Synced to Plane: <a href="${planeIssueUrl}">${planeIssueUrl}</a>`,
      );
    },
  };
}
