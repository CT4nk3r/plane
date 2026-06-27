/**
 * Backfill scope -> Azure DevOps WIQL. These are the preset "buttons" for a
 * one-time pull of *existing* work items (vs. webhook-driven sync of changes).
 * Pure + unit-tested. `@Me` / `@project` / `@Today` are ADO server-side macros.
 */

const DONE_STATES = ["Done", "Closed", "Removed", "Resolved", "Completed"];

/** Human-readable list of supported scopes (for CLI usage output). */
export const BACKFILL_PRESETS = [
  "assigned-to-me",
  "assigned-to:<email-or-name>",
  "created-by-me",
  "created-by:<email-or-name>",
  "active",
  "recent[:days]",
  "sprint:<iteration-name>",
  "area:<area-name>",
  "all",
  "query:<raw WIQL>",
] as const;

/** Escape single quotes for a WIQL string literal. */
function esc(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Build a WIQL query that selects work item ids for the given scope.
 * Throws on an unknown scope or a missing required argument.
 */
export function buildWorkItemWiql(scope: string, project: string): string {
  const trimmed = scope.trim();
  const sep = trimmed.indexOf(":");
  const preset = (sep === -1 ? trimmed : trimmed.slice(0, sep)).toLowerCase();
  const arg = sep === -1 ? "" : trimmed.slice(sep + 1).trim();

  // Power users can pass a full query.
  if (preset === "query") {
    if (!arg) throw new Error("query: requires a WIQL string");
    return arg;
  }

  const base = "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project";
  const order = " ORDER BY [System.ChangedDate] DESC";
  let clause = "";

  switch (preset) {
    case "assigned-to-me":
      clause = " AND [System.AssignedTo] = @Me";
      break;
    case "assigned-to":
      if (!arg) throw new Error("assigned-to: requires a user (email or display name)");
      clause = ` AND [System.AssignedTo] = '${esc(arg)}'`;
      break;
    case "created-by-me":
      clause = " AND [System.CreatedBy] = @Me";
      break;
    case "created-by":
      if (!arg) throw new Error("created-by: requires a user (email or display name)");
      clause = ` AND [System.CreatedBy] = '${esc(arg)}'`;
      break;
    case "active":
      clause = ` AND [System.State] NOT IN (${DONE_STATES.map((s) => `'${s}'`).join(", ")})`;
      break;
    case "recent": {
      const days = arg ? Number(arg) : 14;
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error("recent: days must be a positive number");
      }
      clause = ` AND [System.ChangedDate] >= @Today - ${Math.floor(days)}`;
      break;
    }
    case "sprint":
      if (!arg) throw new Error("sprint: requires an iteration name");
      clause = ` AND [System.IterationPath] UNDER '${esc(project)}\\${esc(arg)}'`;
      break;
    case "area":
      if (!arg) throw new Error("area: requires an area name");
      clause = ` AND [System.AreaPath] UNDER '${esc(project)}\\${esc(arg)}'`;
      break;
    case "all":
      clause = "";
      break;
    default:
      throw new Error(`Unknown backfill scope "${scope}". Supported: ${BACKFILL_PRESETS.join(", ")}`);
  }

  return `${base}${clause}${order}`;
}
