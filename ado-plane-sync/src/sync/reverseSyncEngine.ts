/**
 * Reverse sync engine: Plane issue -> external (Azure DevOps) work item. The
 * mirror of `syncEntity`, sharing the same idempotency philosophy but inverted.
 *
 * Loop prevention is symmetric and clock-safe:
 *  - The ADO->Plane (forward) direction is guarded by `external_rev` (ADO's own
 *    monotonic revision): forward skips when `rev <= last recorded rev`.
 *  - This (Plane->ADO) direction is guarded by `last_plane_updated_at` (Plane's
 *    own monotonic per-issue timestamp): we skip when the incoming issue is not
 *    newer than the Plane state we last wrote/processed. Both watermarks compare
 *    a system against *its own* clock, so there is no cross-system skew.
 *
 * After writing ADO we bump `external_rev` (so the ADO Service Hook echo is
 * absorbed by the forward guard) and after creating we stamp the Plane issue's
 * `external_id`/`external_source` (so the issue is linked and the stamp's own
 * webhook echo is recognized via the watermark).
 */

import type { PlaneClient } from "../clients/plane";
import type { Config } from "../config";
import type { Connector } from "../connectors/types";
import type { SyncStore } from "../db";
import type { Logger } from "../logger";
import type { ConnectionContext, PlaneIssueEvent, PlaneIssuePayload } from "../types";

export interface ReverseSyncDeps {
  config: Config;
  connection: ConnectionContext;
  plane: PlaneClient;
  store: SyncStore;
  logger: Logger;
}

export type ReverseAction = "skipped" | "created" | "updated";

export interface ReverseOutcome {
  action: ReverseAction;
  issueId: string;
  externalId?: string;
  reason?: string;
}

/** Resolve the first Plane assignee's email so ADO can set System.AssignedTo. */
async function resolveAssigneeEmail(event: PlaneIssueEvent, plane: PlaneClient): Promise<string | undefined> {
  const id = event.assigneeIds[0];
  if (!id) return undefined;
  const members = await plane.listMembers();
  return members.find((m) => m.id === id)?.email;
}

/** If the Plane parent is linked to this provider, return its external (ADO) id. */
async function resolveParentExternalId(
  event: PlaneIssueEvent,
  connection: ConnectionContext,
  plane: PlaneClient,
): Promise<string | undefined> {
  if (!event.parentIssueId) return undefined;
  const parent = await plane.getIssueById(event.parentIssueId);
  if (parent && parent.external_source === connection.externalSource && parent.external_id) {
    return String(parent.external_id);
  }
  return undefined;
}

export async function syncPlaneIssue(
  event: PlaneIssueEvent,
  connector: Connector,
  deps: ReverseSyncDeps,
): Promise<ReverseOutcome> {
  const { config, connection, plane, store, logger } = deps;
  const { reverse } = connector;
  const provider = connector.provider;
  const skip = (reason: string, externalId?: string): ReverseOutcome => ({
    action: "skipped",
    issueId: event.issueId,
    externalId,
    reason,
  });

  if (!reverse) return skip("reverse_unsupported");

  // 1. Only mirror issues from the connected Plane project.
  if (event.planeProjectId !== connection.planeProjectId) {
    return skip("other_project");
  }

  // 2. Deletions are not mirrored to ADO in this version (intentionally safe).
  if (event.action === "delete") {
    logger.info("reverse.skip.delete", { issueId: event.issueId });
    return skip("delete_not_mirrored");
  }

  // 3. Resolve the existing link, if any.
  const linkedExternalId =
    event.externalSource === connection.externalSource && event.externalId ? event.externalId : null;
  const mapping = linkedExternalId
    ? await store.getEntitySync(provider, connection.externalOrg, connection.externalProject, linkedExternalId)
    : await store.getEntitySyncByPlaneIssue(provider, event.issueId);
  const externalId = linkedExternalId ?? mapping?.external_id ?? null;

  // 4. Echo guard: skip states we ourselves produced (forward write or stamp).
  //    Compare on Plane's own clock, truncated to ms (Postgres round-trips lose
  //    sub-ms precision), so an echo's timestamp is never treated as "newer".
  if (mapping?.last_plane_updated_at) {
    const incoming = Date.parse(event.updatedAt);
    const watermark = Date.parse(mapping.last_plane_updated_at);
    if (!Number.isNaN(incoming) && !Number.isNaN(watermark) && incoming <= watermark) {
      logger.info("reverse.skip.echo", {
        issueId: event.issueId,
        externalId,
        updatedAt: event.updatedAt,
        watermark: mapping.last_plane_updated_at,
      });
      return skip("echo", externalId ?? undefined);
    }
  }

  const item = reverse.mapPlaneIssue(event);
  const assigneeEmail = config.reverse.syncAssignee ? await resolveAssigneeEmail(event, plane) : undefined;

  const recordMapping = (extId: string, extRev: number, planeUpdatedAt: string, url?: string): Promise<unknown> =>
    store.upsertEntitySync({
      provider,
      externalOrg: connection.externalOrg,
      externalProject: connection.externalProject,
      externalId: extId,
      externalUrl: url ?? mapping?.external_url ?? null,
      externalRev: extRev,
      planeWorkspaceSlug: connection.planeWorkspaceSlug,
      planeProjectId: connection.planeProjectId,
      planeIssueId: event.issueId,
      projectConnectionId: connection.projectConnectionId,
      lastPlaneUpdatedAt: planeUpdatedAt,
    });

  // 5a. UPDATE an already-linked ADO work item.
  if (externalId) {
    const { externalRev } = await reverse.updateExternalItem(externalId, item, { assigneeEmail });
    await recordMapping(externalId, externalRev, event.updatedAt);
    logger.info("reverse.completed", { issueId: event.issueId, externalId, action: "updated" });
    return { action: "updated", issueId: event.issueId, externalId };
  }

  // 5b. CREATE a new ADO work item for a Plane-native issue, then stamp the link.
  const parentExternalId = await resolveParentExternalId(event, connection, plane);
  const created = await reverse.createExternalItem(item, { parentExternalId, assigneeEmail });

  const stamped = await plane.updateIssue(event.issueId, {
    external_id: created.externalId,
    external_source: connection.externalSource,
  } as Partial<PlaneIssuePayload>);
  const stampUpdatedAt = typeof stamped.updated_at === "string" ? stamped.updated_at : event.updatedAt;

  await recordMapping(created.externalId, created.externalRev, stampUpdatedAt, created.url);
  logger.info("reverse.completed", {
    issueId: event.issueId,
    externalId: created.externalId,
    parentExternalId,
    action: "created",
  });
  return { action: "created", issueId: event.issueId, externalId: created.externalId };
}
