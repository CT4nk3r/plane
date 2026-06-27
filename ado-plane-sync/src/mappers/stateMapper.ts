/**
 * State mapping: translate an Azure DevOps state name into the Plane state name
 * to resolve. Mirrors the configured `STATE_MAP_JSON` (e.g. {"New":"Backlog"}).
 * Lookup is case-insensitive. When no mapping exists, the raw ADO state name is
 * returned so a same-named Plane state can still match ("find state by name").
 */

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
