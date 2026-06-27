/**
 * Generic sync engine (external entity -> Plane issue). One engine drives every
 * connector. Idempotency follows Plane's integration model:
 *  - skip when the fetched external rev is not newer than the recorded one;
 *  - link via `external_id` + `external_source` and the local `entity_item_syncs`
 *    mapping;
 *  - emulate upsert: resolve the Plane issue (mapping -> external-id lookup),
 *    PATCH if it exists, otherwise POST, reconciling the 409 "already exists".
 */

import type { PlaneClient } from "../clients/plane";
import type { Config } from "../config";
import type { Connector, NormalizedEvent } from "../connectors/types";
import type { SyncStore } from "../db";
import type { Logger } from "../logger";
import { resolveAssigneeId } from "../mappers/userMapper";
import type { ConnectionContext, PlaneIssuePayload } from "../types";

export interface SyncDeps {
  config: Config;
  connection: ConnectionContext;
  plane: PlaneClient;
  store: SyncStore;
  logger: Logger;
}

export type SyncAction = "skipped" | "created" | "updated";

export interface SyncOutcome {
  action: SyncAction;
  provider: string;
  externalId: string;
  issueId?: string;
  reason?: string;
}

export async function syncEntity(
  connector: Connector,
  event: NormalizedEvent,
  deps: SyncDeps,
): Promise<SyncOutcome> {
  const { config, connection, plane, store, logger } = deps;
  const { provider } = connector;
  const { org, project, externalId } = event;

  // 1. Authoritative fetch + map via the connector.
  const mapped = await connector.fetchEntity(event, connection);
  const rev = mapped.externalRev;

  // 2. Idempotency: skip stale revisions we've already synced.
  const existing = await store.getEntitySync(provider, org, project, externalId);
  if (existing && rev <= existing.external_rev) {
    logger.info("sync.skipped", { provider, externalId, rev, lastRev: existing.external_rev });
    return { action: "skipped", provider, externalId, issueId: existing.plane_issue_id, reason: "stale_rev" };
  }

  // 3. Build the Plane payload (resolve state/labels/assignee).
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
      logger.warn("sync.state_not_found", { externalId, stateName: mapped.stateName });
    }
  }
  const labelIds = new Set(await plane.ensureLabels(mapped.tags));
  if (connection.defaultLabelId) {
    labelIds.add(connection.defaultLabelId);
  }
  if (labelIds.size > 0) {
    payload.labels = [...labelIds];
  }
  const members = await plane.listMembers();
  const assigneeId = resolveAssigneeId(mapped.assignee, connection.userMap, members);
  if (assigneeId) {
    payload.assignees = [assigneeId];
  }

  // 4. Resolve the target Plane issue and write (emulated upsert).
  let issueId: string;
  let action: SyncAction;
  const knownIssueId =
    existing?.plane_issue_id ?? (await lookupExistingIssueId(plane, mapped.externalId, mapped.externalSource));

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
      await plane.updateIssue(result.id, payload);
      issueId = result.id;
      action = "updated";
    }
  }

  // 5. Persist/refresh the mapping row.
  const sync = await store.upsertEntitySync({
    provider,
    externalOrg: org,
    externalProject: project,
    externalId,
    externalUrl: mapped.externalUrl ?? null,
    externalRev: rev,
    planeWorkspaceSlug: connection.planeWorkspaceSlug,
    planeProjectId: connection.planeProjectId,
    planeIssueId: issueId,
    projectConnectionId: connection.projectConnectionId,
  });

  // 6. Optional backlink on the source entity (only on create).
  if (config.ado.backlinkEnabled && action === "created") {
    const issueUrl = `${config.plane.baseUrl}/${connection.planeWorkspaceSlug}/projects/${connection.planeProjectId}/issues/${issueId}`;
    const commentId = await connector.addBacklink(event, issueUrl, connection);
    if (commentId !== null) {
      await store.recordCommentSync({ provider, externalCommentId: commentId, itemSyncId: sync.id });
    }
  }

  logger.info("sync.completed", { provider, externalId, rev, issueId, action });
  return { action, provider, externalId, issueId };
}

async function lookupExistingIssueId(
  plane: PlaneClient,
  externalId: string,
  externalSource: string,
): Promise<string | null> {
  const found = await plane.getWorkItemByExternalId(externalId, externalSource);
  return found ? found.id : null;
}
