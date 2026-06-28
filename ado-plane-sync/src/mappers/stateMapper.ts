/**
 * State mapping: translate an Azure DevOps state name into the Plane state name
 * to resolve. Mirrors the configured `STATE_MAP_JSON` (e.g. {"New":"Backlog"}).
 * Lookup is case-insensitive. When no mapping exists, the raw ADO state name is
 * returned so a same-named Plane state can still match (or be created).
 */

import type { PlaneStateGroup } from "../types";

export function resolvePlaneStateName(
  adoState: string | undefined | null,
  stateMap: Record<string, string>,
): string | undefined {
  if (typeof adoState !== "string" || adoState.trim() === "") {
    return undefined;
  }
  const trimmed = adoState.trim();

  // Exact match first, then case-insensitive.
  if (Object.prototype.hasOwnProperty.call(stateMap, trimmed)) {
    return stateMap[trimmed];
  }
  const lowered = trimmed.toLowerCase();
  for (const [key, value] of Object.entries(stateMap)) {
    if (key.toLowerCase() === lowered) {
      return value;
    }
  }

  // No configured mapping — fall back to the ADO state name itself.
  return trimmed;
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

/**
 * Infer the Plane state group for a (dynamically created) state. An explicit
 * `STATE_GROUP_MAP_JSON` entry wins; otherwise a heuristic on the name; otherwise
 * the configured default. This lets ADO board columns appear in Plane with a
 * sensible category without any manual mapping.
 */
export function inferStateGroup(
  stateName: string,
  groupMap: Record<string, PlaneStateGroup>,
  defaultGroup: PlaneStateGroup,
): PlaneStateGroup {
  const lowered = stateName.trim().toLowerCase();

  for (const [key, value] of Object.entries(groupMap)) {
    if (key.toLowerCase() === lowered) return value;
  }

  if (matchesAny(lowered, ["done", "closed", "complete", "resolved", "shipped", "merged"])) {
    return "completed";
  }
  if (matchesAny(lowered, ["cancel", "removed", "abandon", "reject", "won't", "wont"])) {
    return "cancelled";
  }
  if (matchesAny(lowered, ["backlog", "proposed", "new"])) {
    return "backlog";
  }
  if (matchesAny(lowered, ["to do", "todo", "ready", "approved", "planned", "unstarted"])) {
    return "unstarted";
  }
  return defaultGroup;
}
