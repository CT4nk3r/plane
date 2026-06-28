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
import { createAzureDevOpsReverse } from "./azureDevOpsReverse";
import { buildWorkItemWiql } from "./azureDevOpsBackfill";
import type { Connector, MappedEntity, NormalizedEvent } from "./types";

export const AZURE_DEVOPS_WEBHOOK_SLUG = "azure-devops";

export function createAzureDevOpsConnector(config: Config, logger: Logger): Connector {
  const ado: AzureDevOpsClient = createAzureDevOpsClient(config, logger);
  const provider = config.service;
  const reverse = config.reverse.enabled ? createAzureDevOpsReverse(config, logger, ado) : undefined;

  return {
    provider,
    webhookSlug: AZURE_DEVOPS_WEBHOOK_SLUG,
    reverse,

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

      // Work item type -> label (e.g. "Bug", "User Story", "Test Case").
      const tags = [...mapped.tags];
      if (config.sync.workItemTypeAsLabel && mapped.workItemType) {
        tags.push(`${config.sync.typeLabelPrefix}${mapped.workItemType}`);
      }

      return {
        name: mapped.name,
        descriptionHtml: mapped.descriptionHtml,
        stateName: mapped.stateName,
        tags,
        assignee: mapped.assignee,
        priority: config.sync.priority ? mapped.priority : undefined,
        cycleName: config.sync.iterationsAsCycles ? mapped.cycleName : undefined,
        parentExternalId: config.sync.parent ? mapped.parentExternalId : undefined,
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

    async listEntities(scope: string, ctx: ConnectionContext): Promise<NormalizedEvent[]> {
      const wiql = buildWorkItemWiql(scope, config.ado.project);
      logger.debug("ado.backfill.wiql", { scope, wiql });
      const ids = await ado.queryWorkItemIds(wiql);
      // externalRev 0 -> the engine fetches the authoritative work item (and rev).
      return ids.map((id) => ({
        provider,
        eventType: "backfill",
        externalId: String(id),
        externalRev: 0,
        org: ctx.externalOrg,
        project: ctx.externalProject,
        raw: {},
      }));
    },
  };
}
