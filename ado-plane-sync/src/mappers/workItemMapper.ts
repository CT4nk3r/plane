/**
 * Work item mapper — extracts and normalizes ADO work item fields into an
 * intermediate shape. State/label/assignee *resolution* (name -> Plane UUID)
 * happens in the sync layer, which has the Plane client; this module stays pure
 * and fully unit-testable.
 */

import { resolvePlaneStateName } from "./stateMapper";
import type { AdoUserRef, AdoWorkItem } from "../types";

export interface MappedWorkItem {
  name: string;
  descriptionHtml?: string;
  /** Target Plane state name (already run through the state map). */
  stateName?: string;
  /** Label names derived from ADO tags. */
  tags: string[];
  assignee: AdoUserRef | null;
  workItemType?: string;
  url?: string;
  externalId: string;
  externalSource: string;
}

export interface MapWorkItemOptions {
  stateMap: Record<string, string>;
  externalSource: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** ADO tags are a single "tag1; tag2; tag3" string. */
export function parseTags(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** ADO `System.AssignedTo` may be an object (modern) or "Name <email>" string. */
export function normalizeAdoUser(value: unknown): AdoUserRef | null {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const ref: AdoUserRef = {};
    if (typeof v.id === "string") ref.id = v.id;
    if (typeof v.displayName === "string") ref.displayName = v.displayName;
    if (typeof v.uniqueName === "string") ref.uniqueName = v.uniqueName;
    if (typeof v.mail === "string") ref.mail = v.mail;
    return Object.keys(ref).length > 0 ? ref : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const withEmail = value.match(/^(.*?)[<(]([^\s<>()]+@[^\s<>()]+)[>)]\s*$/);
    if (withEmail) {
      return { displayName: withEmail[1].trim(), uniqueName: withEmail[2].trim() };
    }
    if (/@/.test(value)) {
      return { uniqueName: value.trim() };
    }
    return { displayName: value.trim() };
  }
  return null;
}

export function mapWorkItem(workItem: AdoWorkItem, options: MapWorkItemOptions): MappedWorkItem {
  const fields = workItem.fields ?? {};

  const name = asString(fields["System.Title"]) ?? `Work item ${workItem.id}`;
  const descriptionHtml =
    asString(fields["System.Description"]) ?? asString(fields["Microsoft.VSTS.TCM.ReproSteps"]);
  const stateName = resolvePlaneStateName(asString(fields["System.State"]), options.stateMap);
  const tags = parseTags(fields["System.Tags"]);
  const assignee = normalizeAdoUser(fields["System.AssignedTo"]);
  const workItemType = asString(fields["System.WorkItemType"]);
  const url = workItem._links?.html?.href ?? workItem.url;

  return {
    name,
    descriptionHtml,
    stateName,
    tags,
    assignee,
    workItemType,
    url,
    externalId: String(workItem.id),
    externalSource: options.externalSource,
  };
}
