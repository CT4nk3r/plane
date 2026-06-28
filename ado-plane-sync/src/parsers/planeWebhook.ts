/**
 * Pure parser for Plane's outbound webhooks (the reverse, Plane -> external,
 * direction). Plane sends `{ event, action, webhook_id, workspace_id, data,
 * activity }` with `X-Plane-Event` + an HMAC `X-Plane-Signature` header. Only
 * `event: "issue"` is handled here; everything else is ignored.
 *
 * The `data` payload is Plane's `IssueExpandSerializer` shape: it includes
 * `external_id` / `external_source` (null for Plane-native issues), `parent`
 * (a Plane issue UUID), an expanded `state` ({ name, group }), `assignees` and
 * `labels` (arrays of UUIDs), `priority`, `project`, and `updated_at` (Plane's
 * own monotonic per-issue timestamp, which the reverse engine uses as its
 * echo-guard watermark).
 */

import { WebhookParseError } from "../connectors/types";
import type { PlaneIssueEvent } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Plane verbs are past-tense ("created"); older builds use "create". Normalize both. */
function normalizeAction(value: unknown): "create" | "update" | "delete" {
  const v = typeof value === "string" ? value.toLowerCase() : "";
  if (v.startsWith("creat")) return "create";
  if (v.startsWith("delet")) return "delete";
  return "update";
}

/** assignees/labels arrive as UUID strings or as `{ id }` objects; normalize to ids. */
function toIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") {
      out.push(entry);
    } else if (isRecord(entry)) {
      const id = entry.id ?? entry.assignee_id ?? entry.member_id;
      if (typeof id === "string" && id.trim() !== "") out.push(id);
    }
  }
  return out;
}

/** `parent` may be a UUID string or an expanded `{ id }` object. */
function parentId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (isRecord(value)) return str(value.id);
  return undefined;
}

export function parsePlaneWebhook(body: unknown): PlaneIssueEvent {
  if (!isRecord(body)) {
    throw new WebhookParseError("Webhook body must be a JSON object");
  }

  const event = typeof body.event === "string" ? body.event : "";
  if (event !== "issue") {
    throw new WebhookParseError(`Unsupported Plane event: ${event || "(missing)"}`, "unsupported_event");
  }

  const data = isRecord(body.data) ? body.data : undefined;
  if (!data) {
    throw new WebhookParseError("Plane webhook is missing `data`");
  }

  const issueId = str(data.id);
  if (!issueId) {
    throw new WebhookParseError("Could not determine issue id from Plane webhook");
  }

  const planeProjectId = str(data.project) ?? "";
  if (!planeProjectId) {
    throw new WebhookParseError("Plane webhook issue is missing `project`");
  }

  const state = isRecord(data.state) ? data.state : undefined;

  return {
    action: normalizeAction(body.action),
    issueId,
    name: str(data.name) ?? "(untitled)",
    descriptionHtml: str(data.description_html),
    stateName: state ? str(state.name) : undefined,
    stateGroup: state ? str(state.group) : undefined,
    priority: str(data.priority),
    parentIssueId: parentId(data.parent),
    assigneeIds: toIdList(data.assignees),
    labelIds: toIdList(data.labels),
    externalId: typeof data.external_id === "string" ? data.external_id : null,
    externalSource: typeof data.external_source === "string" ? data.external_source : null,
    planeProjectId,
    updatedAt: str(data.updated_at) ?? new Date().toISOString(),
    sequenceId: typeof data.sequence_id === "number" ? data.sequence_id : undefined,
    raw: body,
  };
}
