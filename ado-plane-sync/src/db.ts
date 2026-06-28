/**
 * Persistence layer. The schema mirrors Plane's GitHub integration tables but is
 * provider-agnostic so one engine can drive many connectors (as Plane's "Silo"
 * does): integrations -> workspace_integrations -> external_projects ->
 * project_connections -> entity_item_syncs -> entity_comment_syncs, plus a
 * sync_jobs queue. Every per-provider row carries a `provider` column.
 *
 * `SyncStore` has a Postgres implementation (production) and an in-memory one
 * (tests / DATABASE_URL-less demos).
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { EntitySync, SyncJobStatus } from "./types";

export interface UpsertIntegrationInput {
  provider: string;
  webhookSecret: string;
  metadata?: Record<string, unknown>;
}

export interface UpsertWorkspaceIntegrationInput {
  integrationId: string;
  planeWorkspaceSlug: string;
  planeApiToken: string;
  actor?: string | null;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface UpsertExternalProjectInput {
  provider: string;
  organization: string;
  project: string;
  externalId?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface UpsertProjectConnectionInput {
  provider: string;
  externalProjectId: string;
  workspaceIntegrationId: string;
  service: string;
  status?: SyncJobStatus;
  planeProjectId: string;
  credentials?: Record<string, unknown>;
  defaultLabelId?: string | null;
  config?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface UpsertEntitySyncInput {
  provider: string;
  externalOrg: string;
  externalProject: string;
  externalId: string;
  externalUrl?: string | null;
  externalRev: number;
  planeWorkspaceSlug: string;
  planeProjectId: string;
  planeIssueId: string;
  projectConnectionId?: string | null;
  lastPlaneUpdatedAt?: string | null;
}

export interface RecordCommentSyncInput {
  provider: string;
  externalCommentId?: number | null;
  planeCommentId?: string | null;
  itemSyncId: string;
}

export interface SyncStore {
  upsertIntegration(input: UpsertIntegrationInput): Promise<{ id: string }>;
  upsertWorkspaceIntegration(input: UpsertWorkspaceIntegrationInput): Promise<{ id: string }>;
  upsertExternalProject(input: UpsertExternalProjectInput): Promise<{ id: string }>;
  upsertProjectConnection(
    input: UpsertProjectConnectionInput,
  ): Promise<{ id: string; defaultLabelId: string | null }>;
  setProjectConnectionDefaultLabel(id: string, labelId: string): Promise<void>;
  getEntitySync(provider: string, org: string, project: string, externalId: string): Promise<EntitySync | null>;
  getEntitySyncByPlaneIssue(provider: string, planeIssueId: string): Promise<EntitySync | null>;
  upsertEntitySync(input: UpsertEntitySyncInput): Promise<EntitySync>;
  recordCommentSync(input: RecordCommentSyncInput): Promise<void>;
  close(): Promise<void>;
}

// --- Schema ----------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT UNIQUE NOT NULL,
  webhook_secret TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  verified BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  plane_workspace_slug TEXT NOT NULL,
  plane_api_token TEXT NOT NULL,
  actor TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plane_workspace_slug, integration_id)
);

CREATE TABLE IF NOT EXISTS external_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  organization TEXT NOT NULL,
  project TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, organization, project)
);

CREATE TABLE IF NOT EXISTS project_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  external_project_id UUID REFERENCES external_projects(id) ON DELETE CASCADE,
  workspace_integration_id UUID REFERENCES workspace_integrations(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  plane_project_id TEXT NOT NULL,
  credentials JSONB NOT NULL DEFAULT '{}',
  default_label_id TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, plane_project_id, external_project_id)
);

CREATE TABLE IF NOT EXISTS entity_item_syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  external_org TEXT NOT NULL,
  external_project TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_url TEXT,
  external_rev INTEGER NOT NULL DEFAULT 0,
  plane_workspace_slug TEXT NOT NULL,
  plane_project_id TEXT NOT NULL,
  plane_issue_id TEXT NOT NULL,
  project_connection_id UUID REFERENCES project_connections(id) ON DELETE SET NULL,
  last_plane_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_org, external_project, external_id)
);

CREATE TABLE IF NOT EXISTS entity_comment_syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  external_comment_id BIGINT,
  plane_comment_id TEXT,
  item_sync_id UUID REFERENCES entity_item_syncs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_jobs_status_due_idx ON sync_jobs (status, next_attempt_at);
`;

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  // Additive migration for stores created before reverse sync existed.
  await pool.query(
    `ALTER TABLE entity_item_syncs ADD COLUMN IF NOT EXISTS last_plane_updated_at TIMESTAMPTZ`,
  );
}

// --- Postgres store --------------------------------------------------------

function json(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function rowToEntitySync(row: Record<string, unknown>): EntitySync {
  return {
    id: String(row.id),
    provider: String(row.provider),
    external_org: String(row.external_org),
    external_project: String(row.external_project),
    external_id: String(row.external_id),
    external_url: (row.external_url as string | null) ?? null,
    external_rev: Number(row.external_rev),
    plane_workspace_slug: String(row.plane_workspace_slug),
    plane_project_id: String(row.plane_project_id),
    plane_issue_id: String(row.plane_issue_id),
    project_connection_id: (row.project_connection_id as string | null) ?? null,
    last_plane_updated_at: row.last_plane_updated_at
      ? new Date(row.last_plane_updated_at as string).toISOString()
      : null,
    created_at: new Date(row.created_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  };
}

export function createPgSyncStore(pool: Pool): SyncStore {
  return {
    async upsertIntegration(input) {
      const res = await pool.query(
        `INSERT INTO integrations (provider, webhook_secret, metadata)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (provider) DO UPDATE
           SET webhook_secret = EXCLUDED.webhook_secret, metadata = EXCLUDED.metadata, updated_at = now()
         RETURNING id`,
        [input.provider, input.webhookSecret, json(input.metadata)],
      );
      return { id: String(res.rows[0].id) };
    },

    async upsertWorkspaceIntegration(input) {
      const res = await pool.query(
        `INSERT INTO workspace_integrations
           (integration_id, plane_workspace_slug, plane_api_token, actor, config, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (plane_workspace_slug, integration_id) DO UPDATE
           SET plane_api_token = EXCLUDED.plane_api_token, actor = EXCLUDED.actor,
               config = EXCLUDED.config, metadata = EXCLUDED.metadata, updated_at = now()
         RETURNING id`,
        [
          input.integrationId,
          input.planeWorkspaceSlug,
          input.planeApiToken,
          input.actor ?? null,
          json(input.config),
          json(input.metadata),
        ],
      );
      return { id: String(res.rows[0].id) };
    },

    async upsertExternalProject(input) {
      const res = await pool.query(
        `INSERT INTO external_projects (provider, organization, project, external_id, url, metadata, config)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
         ON CONFLICT (provider, organization, project) DO UPDATE
           SET external_id = EXCLUDED.external_id, url = EXCLUDED.url,
               metadata = EXCLUDED.metadata, config = EXCLUDED.config, updated_at = now()
         RETURNING id`,
        [
          input.provider,
          input.organization,
          input.project,
          input.externalId ?? null,
          input.url ?? null,
          json(input.metadata),
          json(input.config),
        ],
      );
      return { id: String(res.rows[0].id) };
    },

    async upsertProjectConnection(input) {
      const res = await pool.query(
        `INSERT INTO project_connections
           (provider, external_project_id, workspace_integration_id, service, status,
            plane_project_id, credentials, default_label_id, config, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb)
         ON CONFLICT (provider, plane_project_id, external_project_id) DO UPDATE
           SET workspace_integration_id = EXCLUDED.workspace_integration_id,
               service = EXCLUDED.service, status = EXCLUDED.status,
               credentials = EXCLUDED.credentials,
               default_label_id = COALESCE(EXCLUDED.default_label_id, project_connections.default_label_id),
               config = EXCLUDED.config, data = EXCLUDED.data, updated_at = now()
         RETURNING id, default_label_id`,
        [
          input.provider,
          input.externalProjectId,
          input.workspaceIntegrationId,
          input.service,
          input.status ?? "queued",
          input.planeProjectId,
          json(input.credentials),
          input.defaultLabelId ?? null,
          json(input.config),
          json(input.data),
        ],
      );
      return {
        id: String(res.rows[0].id),
        defaultLabelId: (res.rows[0].default_label_id as string | null) ?? null,
      };
    },

    async setProjectConnectionDefaultLabel(id, labelId) {
      await pool.query(
        `UPDATE project_connections SET default_label_id = $2, updated_at = now() WHERE id = $1`,
        [id, labelId],
      );
    },

    async getEntitySync(provider, org, project, externalId) {
      const res = await pool.query(
        `SELECT * FROM entity_item_syncs
         WHERE provider = $1 AND external_org = $2 AND external_project = $3 AND external_id = $4`,
        [provider, org, project, externalId],
      );
      return res.rows[0] ? rowToEntitySync(res.rows[0]) : null;
    },

    async getEntitySyncByPlaneIssue(provider, planeIssueId) {
      const res = await pool.query(
        `SELECT * FROM entity_item_syncs WHERE provider = $1 AND plane_issue_id = $2 LIMIT 1`,
        [provider, planeIssueId],
      );
      return res.rows[0] ? rowToEntitySync(res.rows[0]) : null;
    },

    async upsertEntitySync(input) {
      const res = await pool.query(
        `INSERT INTO entity_item_syncs
           (provider, external_org, external_project, external_id, external_url, external_rev,
            plane_workspace_slug, plane_project_id, plane_issue_id, project_connection_id, last_plane_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (provider, external_org, external_project, external_id) DO UPDATE
           SET external_url = EXCLUDED.external_url, external_rev = EXCLUDED.external_rev,
               plane_workspace_slug = EXCLUDED.plane_workspace_slug,
               plane_project_id = EXCLUDED.plane_project_id,
               plane_issue_id = EXCLUDED.plane_issue_id,
               project_connection_id = EXCLUDED.project_connection_id,
               last_plane_updated_at = COALESCE(EXCLUDED.last_plane_updated_at, entity_item_syncs.last_plane_updated_at),
               updated_at = now()
         RETURNING *`,
        [
          input.provider,
          input.externalOrg,
          input.externalProject,
          input.externalId,
          input.externalUrl ?? null,
          input.externalRev,
          input.planeWorkspaceSlug,
          input.planeProjectId,
          input.planeIssueId,
          input.projectConnectionId ?? null,
          input.lastPlaneUpdatedAt ?? null,
        ],
      );
      return rowToEntitySync(res.rows[0]);
    },

    async recordCommentSync(input) {
      await pool.query(
        `INSERT INTO entity_comment_syncs (provider, external_comment_id, plane_comment_id, item_sync_id)
         VALUES ($1, $2, $3, $4)`,
        [input.provider, input.externalCommentId ?? null, input.planeCommentId ?? null, input.itemSyncId],
      );
    },

    async close() {
      await pool.end();
    },
  };
}

// --- In-memory store (tests / no-DATABASE_URL demos) -----------------------

export function createInMemorySyncStore(): SyncStore {
  const integrations = new Map<string, { id: string }>();
  const workspaceIntegrations = new Map<string, { id: string }>();
  const externalProjects = new Map<string, { id: string }>();
  const projectConnections = new Map<string, { id: string; defaultLabelId: string | null }>();
  const entitySyncs = new Map<string, EntitySync>();
  const commentSyncs: RecordCommentSyncInput[] = [];

  const key = (...parts: (string | number)[]): string => parts.join("::");

  return {
    async upsertIntegration(input) {
      const id = integrations.get(input.provider)?.id ?? randomUUID();
      integrations.set(input.provider, { id });
      return { id };
    },

    async upsertWorkspaceIntegration(input) {
      const k = key(input.planeWorkspaceSlug, input.integrationId);
      const id = workspaceIntegrations.get(k)?.id ?? randomUUID();
      workspaceIntegrations.set(k, { id });
      return { id };
    },

    async upsertExternalProject(input) {
      const k = key(input.provider, input.organization, input.project);
      const id = externalProjects.get(k)?.id ?? randomUUID();
      externalProjects.set(k, { id });
      return { id };
    },

    async upsertProjectConnection(input) {
      const k = key(input.provider, input.planeProjectId, input.externalProjectId);
      const existing = projectConnections.get(k);
      const id = existing?.id ?? randomUUID();
      const defaultLabelId = input.defaultLabelId ?? existing?.defaultLabelId ?? null;
      projectConnections.set(k, { id, defaultLabelId });
      return { id, defaultLabelId };
    },

    async setProjectConnectionDefaultLabel(id, labelId) {
      for (const [k, value] of projectConnections) {
        if (value.id === id) projectConnections.set(k, { id, defaultLabelId: labelId });
      }
    },

    async getEntitySync(provider, org, project, externalId) {
      return entitySyncs.get(key(provider, org, project, externalId)) ?? null;
    },

    async getEntitySyncByPlaneIssue(provider, planeIssueId) {
      for (const record of entitySyncs.values()) {
        if (record.provider === provider && record.plane_issue_id === planeIssueId) {
          return record;
        }
      }
      return null;
    },

    async upsertEntitySync(input) {
      const k = key(input.provider, input.externalOrg, input.externalProject, input.externalId);
      const now = new Date().toISOString();
      const existing = entitySyncs.get(k);
      const record: EntitySync = {
        id: existing?.id ?? randomUUID(),
        provider: input.provider,
        external_org: input.externalOrg,
        external_project: input.externalProject,
        external_id: input.externalId,
        external_url: input.externalUrl ?? null,
        external_rev: input.externalRev,
        plane_workspace_slug: input.planeWorkspaceSlug,
        plane_project_id: input.planeProjectId,
        plane_issue_id: input.planeIssueId,
        project_connection_id: input.projectConnectionId ?? null,
        last_plane_updated_at: input.lastPlaneUpdatedAt ?? existing?.last_plane_updated_at ?? null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      entitySyncs.set(k, record);
      return record;
    },

    async recordCommentSync(input) {
      commentSyncs.push(input);
    },

    async close() {
      /* no-op */
    },
  };
}
