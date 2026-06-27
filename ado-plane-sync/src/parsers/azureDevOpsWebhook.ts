/**
 * Pure parser for inbound Azure DevOps Service Hook webhooks.
 *
 * `workitem.created` carries a flat `resource.fields`; `workitem.updated`
 * carries `{ oldValue, newValue }` field diffs plus a full snapshot in
 * `resource.revision.fields`. We normalize both into a flat envelope. The
 * worker still fetches the authoritative work item from ADO afterwards, so the
 * fields here are a best-effort fallback.
 */

import type { ParsedWebhookEvent } from "../types";

export interface ParseFallback {
  org: string;
  project: string;
}

const WORK_ITEM_EVENTS = new Set(["workitem.created", "workitem.updated", "workitem.restored"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** ADO update events wrap each field as { oldValue, newValue }; unwrap to the new value. */
function flattenFields(fields: unknown): Record<string, unknown> {
  if (!isRecord(fields)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isRecord(value) && ("newValue" in value || "oldValue" in value)) {
      out[key] = (value as { newValue?: unknown }).newValue;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Derive the organization name from an ADO work item URL, if possible. */
export function deriveOrgFromUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  // https://dev.azure.com/{org}/...
  const devAzure = url.match(/dev\.azure\.com\/([^/]+)/i);
  if (devAzure?.[1]) return decodeURIComponent(devAzure[1]);
  // https://{org}.visualstudio.com/...
  const vsts = url.match(/https?:\/\/([^.]+)\.visualstudio\.com/i);
  if (vsts?.[1]) return vsts[1];
  return undefined;
}

export type WebhookParseErrorCode = "unsupported_event" | "invalid";

export class WebhookParseError extends Error {
  readonly code: WebhookParseErrorCode;
  constructor(message: string, code: WebhookParseErrorCode = "invalid") {
    super(message);
    this.name = "WebhookParseError";
    this.code = code;
  }
}

/**
 * Parse an ADO webhook body into a normalized envelope. `fallback` supplies the
 * org/project the service is configured for (the payload does not reliably
 * include the org name).
 */
export function parseWorkItemEvent(body: unknown, fallback: ParseFallback): ParsedWebhookEvent {
  if (!isRecord(body)) {
    throw new WebhookParseError("Webhook body must be a JSON object");
  }

  const eventType = typeof body.eventType === "string" ? body.eventType : "";
  if (!WORK_ITEM_EVENTS.has(eventType)) {
    throw new WebhookParseError(`Unsupported event type: ${eventType || "(missing)"}`, "unsupported_event");
  }

  const resource = isRecord(body.resource) ? body.resource : undefined;
  if (!resource) {
    throw new WebhookParseError("Webhook is missing `resource`");
  }

  const revision = isRecord(resource.revision) ? resource.revision : undefined;
  const workItemId = toNumber(resource.workItemId) ?? toNumber(resource.id) ?? toNumber(revision?.id);
  if (workItemId === undefined) {
    throw new WebhookParseError("Could not determine work item id from webhook");
  }

  // Prefer the full revision snapshot (updated events); fall back to flat fields.
  const fieldsSource = revision?.fields ?? resource.fields;
  const fields = flattenFields(fieldsSource);

  const rev =
    toNumber(resource.rev) ??
    toNumber(revision?.rev) ??
    toNumber(fields["System.Rev"]) ??
    0;

  const resourceContainers = isRecord(body.resourceContainers) ? body.resourceContainers : undefined;
  const containerProject = isRecord(resourceContainers?.project) ? resourceContainers.project : undefined;

  const project =
    (typeof fields["System.TeamProject"] === "string" ? (fields["System.TeamProject"] as string) : undefined) ??
    (typeof containerProject?.name === "string" ? (containerProject.name as string) : undefined) ??
    fallback.project;

  const links = isRecord(resource._links) ? resource._links : undefined;
  const htmlLink = isRecord(links?.html) ? (links.html as { href?: unknown }).href : undefined;
  const org = deriveOrgFromUrl(resource.url) ?? deriveOrgFromUrl(htmlLink) ?? fallback.org;

  return { eventType, workItemId, rev, org, project, fields };
}
