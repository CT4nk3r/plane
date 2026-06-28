/**
 * Azure DevOps reverse connector: write a Plane issue back into ADO as a work
 * item. Required fields (title, description, parent link) are always sent;
 * best-effort optional fields (state, assignee, area/iteration path) are sent
 * too but, if ADO rejects them (e.g. an invalid state for the work item type or
 * an unknown identity), the write is retried with only the required fields so a
 * single bad field never blocks the sync.
 */

import type { AzureDevOpsClient, AdoPatchOp } from "../clients/azureDevOps";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { PlaneIssueEvent } from "../types";
import type {
  ReverseConnector,
  ReverseMappedItem,
  ReverseWriteOptions,
  ReverseWriteResult,
} from "./types";

export function createAzureDevOpsReverse(
  config: Config,
  logger: Logger,
  ado: AzureDevOpsClient,
): ReverseConnector {
  const { reverse } = config;

  function parentRelationUrl(parentExternalId: string): string {
    return `${config.ado.baseUrl}/${encodeURIComponent(config.ado.org)}/_apis/wit/workItems/${parentExternalId}`;
  }

  function mapPlaneIssue(event: PlaneIssueEvent): ReverseMappedItem {
    // Plane state name -> ADO state, only when explicitly mapped (state names
    // are process-specific in ADO, so we never guess).
    const stateName = event.stateName ? reverse.stateMap[event.stateName] : undefined;
    return {
      title: event.name,
      descriptionHtml: event.descriptionHtml,
      stateName,
      areaPath: reverse.defaultAreaPath,
      iterationPath: reverse.defaultIterationPath,
    };
  }

  /** Field ops that must succeed; dropping these would lose the work item's identity. */
  function requiredOps(item: ReverseMappedItem, opts: ReverseWriteOptions, create: boolean): AdoPatchOp[] {
    const op = create ? "add" : "replace";
    const ops: AdoPatchOp[] = [{ op, path: "/fields/System.Title", value: item.title }];
    if (item.descriptionHtml !== undefined) {
      ops.push({ op, path: "/fields/System.Description", value: item.descriptionHtml });
    }
    // Parent links can only be added (and only make sense at create time here).
    if (create && opts.parentExternalId) {
      ops.push({
        op: "add",
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: parentRelationUrl(opts.parentExternalId),
        },
      });
    }
    return ops;
  }

  /** Best-effort field ops; ADO may reject any of these, so they are retried-away on failure. */
  function optionalOps(item: ReverseMappedItem, opts: ReverseWriteOptions, create: boolean): AdoPatchOp[] {
    const op = create ? "add" : "replace";
    const ops: AdoPatchOp[] = [];
    if (item.stateName) ops.push({ op, path: "/fields/System.State", value: item.stateName });
    if (reverse.syncAssignee && opts.assigneeEmail) {
      ops.push({ op, path: "/fields/System.AssignedTo", value: opts.assigneeEmail });
    }
    if (create && item.areaPath) ops.push({ op, path: "/fields/System.AreaPath", value: item.areaPath });
    if (create && item.iterationPath) {
      ops.push({ op, path: "/fields/System.IterationPath", value: item.iterationPath });
    }
    return ops;
  }

  async function createExternalItem(
    item: ReverseMappedItem,
    opts: ReverseWriteOptions,
  ): Promise<ReverseWriteResult> {
    const required = requiredOps(item, opts, true);
    const optional = optionalOps(item, opts, true);
    let workItem;
    try {
      workItem = await ado.createWorkItem(reverse.defaultWorkItemType, [...required, ...optional]);
    } catch (error) {
      if (optional.length === 0) throw error;
      logger.warn("reverse.create.retry_without_optional", {
        error: error instanceof Error ? error.message : String(error),
      });
      workItem = await ado.createWorkItem(reverse.defaultWorkItemType, required);
    }
    return {
      externalId: String(workItem.id),
      externalRev: workItem.rev,
      url: workItem._links?.html?.href,
    };
  }

  async function updateExternalItem(
    externalId: string,
    item: ReverseMappedItem,
    opts: ReverseWriteOptions,
  ): Promise<{ externalRev: number }> {
    const id = Number(externalId);
    const required = requiredOps(item, opts, false);
    const optional = optionalOps(item, opts, false);
    let workItem;
    try {
      workItem = await ado.updateWorkItem(id, [...required, ...optional]);
    } catch (error) {
      if (optional.length === 0) throw error;
      logger.warn("reverse.update.retry_without_optional", {
        externalId,
        error: error instanceof Error ? error.message : String(error),
      });
      workItem = await ado.updateWorkItem(id, required);
    }
    return { externalRev: workItem.rev };
  }

  return { mapPlaneIssue, createExternalItem, updateExternalItem };
}
