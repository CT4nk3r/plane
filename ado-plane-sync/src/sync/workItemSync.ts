/**
 * Work item sync orchestration (ADO -> Plane).
 *
 * Idempotency follows Plane's integration model:
 *  - skip when the fetched ADO rev is not newer than the recorded `last_ado_rev`;
 *  - link via `external_id` + `external_source` and the local `ado_work_item_syncs`
 *    mapping;
 *  - emulate upsert: resolve the Plane issue (mapping -> external-id lookup),
 *    PATCH if it exists, otherwise POST, reconciling the 409 "already exists".
 */

import type { AzureDevOpsClient } from "../clients/azureDevOps";
import type { PlaneClient } from "../clients/plane";
import type { Config } from "../config";
import type { ConnectionContext } from "../types";
import type { SyncStore } from "../db";
import type { Logger } from "../logger";
import { mapWorkItem } from "../mappers/workItemMapper";
import { resolveAssigneeId } from "../mappers/userMapper";
import type { ParsedWebhookEvent, PlaneIssuePayload } from "../types";

export interface SyncDeps {
  config: Config;
  connection: ConnectionContext;
  ado: AzureDevOpsClient;
  plane: PlaneClient;
  store: SyncStore;
  logger: Logger;
}

export type SyncAction = "skipped" | "created" | "updated";

export interface SyncOutcome {
  action: SyncAction;
  workItemId: number;
  issueId?: string;
  reason?: string;
}

export async function syncWorkItem(event: ParsedWebhookEvent, deps: SyncDeps): Promise<SyncOutcome> {
  const { config, connection, ado, plane, store, logger } = deps;
  const { org, project, workItemId } = event;

  // 1. Authoritative fetch from ADO (uniform handling of created/updated).
  const workItem = await ado.getWorkItem(workItemId);
  const rev = workItem.rev ?? event.rev;

  // 2. Idempotency: skip stale revisions we've already synced.
  const existing = await store.getWorkItemSync(org, project, workItemId);
  if (existing && rev <= existing.last_ado_rev) {
    logger.info("sync.skipped", { workItemId, rev, lastRev: existing.last_ado_rev });
    return { action: "skipped", workItemId, issueId: existing.plane_issue_id, reason: "stale_rev" };
  }

  // 3. Map ADO fields -> intermediate, then resolve to Plane ids.
  const mapped = mapWorkItem(workItem, {
    stateMap: connection.stateMap,
    externalSource: connection.externalSource,
  });

  const payload: PlaneIssuePayload = {
    name: mapped.name,
    external_id: mapped.externalId,
    external_source: mapped.externalSource,
  };

  if (mapped.descriptionHtml) {
    payload.description_html = mapped.descriptionHtml;
  }

  if (mapped.stateName) {
    const state = await plane.findStateByName(mapped.stateName);
    if (state) {
      payload.state = state.id;
    } else {
      logger.warn("sync.state_not_found", { workItemId, stateName: mapped.stateName });
    }
  }

  // Labels: ADO tags (find-or-create) + the default sync label.
  const labelIds = new Set(await plane.ensureLabels(mapped.tags));
  if (connection.defaultLabelId) {
    labelIds.add(connection.defaultLabelId);
  }
  if (labelIds.size > 0) {
    payload.labels = [...labelIds];
  }

  // Assignee: native data.users mapping (omit when unresolved to avoid clobbering).
  const members = await plane.listMembers();
  const assigneeId = resolveAssigneeId(mapped.assignee, connection.userMap, members);
  if (assigneeId) {
    payload.assignees = [assigneeId];
  }

  // 4. Resolve the target Plane issue and write (emulated upsert).
  let issueId: string;
  let action: SyncAction;

  const knownIssueId = existing?.plane_issue_id ?? (await lookupExistingIssueId(plane, mapped.externalId, connection.externalSource));

  if (knownIssueId) {
    await plane.updateIssue(knownIssueId, payload);
    issueId = knownIssueId;
    action = "updated";
  } else {
    const result = await plane.createIssue(payload);
    if (result.status === "created") {
      issueId = result.issue.id;
      action = "created";
    } else {
      // Reconcile the 409: an issue with this external id already exists.
      await plane.updateIssue(result.id, payload);
      issueId = result.id;
      action = "updated";
    }
  }

  // 5. Persist/refresh the mapping row.
  const sync = await store.upsertWorkItemSync({
    adoOrg: org,
    adoProject: project,
    adoWorkItemId: workItemId,
    adoWorkItemUrl: mapped.url ?? null,
    planeWorkspaceSlug: connection.planeWorkspaceSlug,
    planeProjectId: connection.planeProjectId,
    planeIssueId: issueId,
    projectSyncId: connection.projectSyncId,
    lastAdoRev: rev,
  });

  // 6. Optional ADO backlink comment (only when the issue is newly created, to
  //    avoid duplicate comments on every update).
  if (config.ado.backlinkEnabled && action === "created") {
    const issueUrl = `${config.plane.baseUrl}/${connection.planeWorkspaceSlug}/projects/${connection.planeProjectId}/issues/${issueId}`;
    const commentId = await ado.addBacklinkComment(
      workItemId,
      `Synced to Plane: <a href="${issueUrl}">${issueUrl}</a>`,
    );
    if (commentId !== null) {
      await store.recordCommentSync({ adoCommentId: commentId, workItemSyncId: sync.id });
    }
  }

  logger.info("sync.completed", { workItemId, rev, issueId, action });
  return { action, workItemId, issueId };
}

async function lookupExistingIssueId(
  plane: PlaneClient,
  externalId: string,
  externalSource: string,
): Promise<string | null> {
  const found = await plane.getWorkItemByExternalId(externalId, externalSource);
  return found ? found.id : null;
}
