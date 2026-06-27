/**
 * Shared domain types for ado-plane-sync.
 *
 * Naming intentionally follows Plane's integration conventions (see
 * apps/api/plane/db/models/integration/* and packages/types/src/importer/*):
 * a provider `service`/`external_source` slug, an importer-shaped connection
 * record ({ metadata, config, data }), `data.users` user mapping, and the
 * `external_id`/`external_source` link used across Plane entities.
 */

// --- Azure DevOps ----------------------------------------------------------

/** A user reference as it appears in an external provider's fields. */
export interface ExternalUserRef {
  id?: string;
  displayName?: string;
  uniqueName?: string;
  mail?: string;
}

/** The authoritative work item returned by the ADO REST API. */
export interface AdoWorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  url?: string;
  _links?: { html?: { href?: string } };
}

/** Normalized envelope extracted from an inbound ADO Service Hook webhook. */
export interface ParsedWebhookEvent {
  eventType: string;
  workItemId: number;
  rev: number;
  org: string;
  project: string;
  /** Best-effort flat field snapshot from the payload (fallback only). */
  fields: Record<string, unknown>;
}

// --- User mapping (native data.users idiom) --------------------------------

export type UserImportMode = "map" | "invite" | false;

export interface UserMapEntry {
  username: string;
  import: UserImportMode;
  email: string;
}

// --- Plane -----------------------------------------------------------------

export type PlanePriority = "urgent" | "high" | "medium" | "low" | "none";

export type PlaneStateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

/** Body sent to Plane to create/update a work item (issue). */
export interface PlaneIssuePayload {
  name: string;
  description_html?: string;
  priority?: PlanePriority;
  state?: string;
  assignees?: string[];
  labels?: string[];
  parent?: string;
  external_id: string;
  external_source: string;
}

export interface PlaneIssue {
  id: string;
  name?: string;
  external_id?: string | null;
  external_source?: string | null;
  [key: string]: unknown;
}

export interface PlaneState {
  id: string;
  name: string;
  group?: string;
  color?: string;
}

export interface PlaneLabel {
  id: string;
  name: string;
  color?: string;
}

export interface PlaneMember {
  id: string;
  email?: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
}

// --- Connection (the bootstrapped install/connection context) --------------

/**
 * The resolved connection the worker uses per job. Mirrors the relationship
 * Integration -> WorkspaceIntegration -> external_project -> project_connection,
 * flattened into the data the sync engine needs. Provider-agnostic so the same
 * engine drives any connector.
 */
export interface ConnectionContext {
  integrationId: string;
  workspaceIntegrationId: string;
  externalProjectId: string;
  projectConnectionId: string;
  provider: string;
  externalSource: string;
  externalOrg: string;
  externalProject: string;
  planeWorkspaceSlug: string;
  planeProjectId: string;
  defaultLabelId: string | null;
  stateMap: Record<string, string>;
  userMap: UserMapEntry[];
}

// --- Persistence rows ------------------------------------------------------

/** Provider-agnostic entity mapping: mirrors GitHub's per-entity *_syncs. */
export interface EntitySync {
  id: string;
  provider: string;
  external_org: string;
  external_project: string;
  external_id: string;
  external_url: string | null;
  external_rev: number;
  plane_workspace_slug: string;
  plane_project_id: string;
  plane_issue_id: string;
  project_connection_id: string | null;
  created_at: string;
  updated_at: string;
}

export type SyncJobStatus = "queued" | "processing" | "completed" | "failed";

export interface SyncJob {
  id: string;
  dedupe_key: string;
  event_type: string;
  payload: unknown;
  status: SyncJobStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
}
