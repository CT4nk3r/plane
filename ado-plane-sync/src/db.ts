/**
 * Persistence layer. The schema mirrors Plane's GitHub integration tables
 * (integrations -> workspace_integrations -> ado_projects -> ado_project_syncs
 * -> ado_work_item_syncs -> ado_comment_syncs) plus a sync_jobs queue table.
 *
 * `SyncStore` exposes the operations the connection bootstrap and work-item
 * sync need. Two implementations are provided: `PgSyncStore` (production) and
 * `InMemorySyncStore` (tests / DATABASE_URL-less demos).
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { SyncJobStatus, WorkItemSync } from "./types";

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

export interface UpsertAdoProjectInput {
  adoProjectId?: string | null;
  organization: string;
  project: string;
  url?: string | null;
  metadata?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface UpsertProjectSyncInput {
  adoProjectId: string;
  workspaceIntegrationId: string;
  service: string;
  status?: SyncJobStatus;
  planeProjectId: string;
  credentials?: Record<string, unknown>;
  defaultLabelId?: string | null;
  config?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface UpsertWorkItemSyncInput {
  adoOrg: string;
  adoProject: string;
  adoWorkItemId: number;
  adoWorkItemUrl?: string | null;
  planeWorkspaceSlug: string;
  planeProjectId: string;
  planeIssueId: string;
  projectSyncId?: string | null;
  lastAdoRev: number;
}

export interface RecordCommentSyncInput {
  adoCommentId?: number | null;
  planeCommentId?: string | null;
  workItemSyncId: string;
}

export interface SyncStore {
  upsertIntegration(input: UpsertIntegrationInput): Promise<{ id: string }>;
  upsertWorkspaceIntegration(input: UpsertWorkspaceIntegrationInput): Promise<{ id: string }>;
  upsertAdoProject(input: UpsertAdoProjectInput): Promise<{ id: string }>;
  upsertProjectSync(input: UpsertProjectSyncInput): Promise<{ id: string; defaultLabelId: string | null }>;
  setProjectSyncDefaultLabel(id: string, labelId: string): Promise<void>;
  getWorkItemSync(org: string, project: string, workItemId: number): Promise<WorkItemSync | null>;
  upsertWorkItemSync(input: UpsertWorkItemSyncInput): Promise<WorkItemSync>;
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

CREATE TABLE IF NOT EXISTS ado_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ado_project_id TEXT,
  organization TEXT NOT NULL,
  project TEXT NOT NULL,
  url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization, project)
);

CREATE TABLE IF NOT EXISTS ado_project_syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ado_project_id UUID REFERENCES ado_projects(id) ON DELETE CASCADE,
  workspace_integration_id UUID REFERENCES workspace_integrations(id) ON DELETE CASCADE,
  service TEXT NOT NULL DEFAULT 'azure_devops',
  status TEXT NOT NULL DEFAULT 'queued',
  plane_project_id TEXT NOT NULL,
  credentials JSONB NOT NULL DEFAULT '{}',
  default_label_id TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plane_project_id, ado_project_id)
);

CREATE TABLE IF NOT EXISTS ado_work_item_syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ado_org TEXT NOT NULL,
  ado_project TEXT NOT NULL,
  ado_work_item_id BIGINT NOT NULL,
  ado_work_item_url TEXT,
  plane_workspace_slug TEXT NOT NULL,
  plane_project_id TEXT NOT NULL,
  plane_issue_id TEXT NOT NULL,
  project_sync_id UUID REFERENCES ado_project_syncs(id) ON DELETE SET NULL,
  last_ado_rev INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ado_org, ado_project, ado_work_item_id)
);

CREATE TABLE IF NOT EXISTS ado_comment_syncs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ado_comment_id BIGINT,
  plane_comment_id TEXT,
  work_item_sync_id UUID REFERENCES ado_work_item_syncs(id) ON DELETE CASCADE,
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
}

// --- Postgres store --------------------------------------------------------

function json(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function rowToWorkItemSync(row: Record<string, unknown>): WorkItemSync {
  return {
    id: String(row.id),
    ado_org: String(row.ado_org),
    ado_project: String(row.ado_project),
    ado_work_item_id: Number(row.ado_work_item_id),
    ado_work_item_url: (row.ado_work_item_url as string | null) ?? null,
    plane_workspace_slug: String(row.plane_workspace_slug),
    plane_project_id: String(row.plane_project_id),
    plane_issue_id: String(row.plane_issue_id),
    project_sync_id: (row.project_sync_id as string | null) ?? null,
    last_ado_rev: Number(row.last_ado_rev),
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
           SET webhook_secret = EXCLUDED.webhook_secret,
               metadata = EXCLUDED.metadata,
               updated_at = now()
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
           SET plane_api_token = EXCLUDED.plane_api_token,
               actor = EXCLUDED.actor,
               config = EXCLUDED.config,
               metadata = EXCLUDED.metadata,
               updated_at = now()
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

    async upsertAdoProject(input) {
      const res = await pool.query(
        `INSERT INTO ado_projects (ado_project_id, organization, project, url, metadata, config)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (organization, project) DO UPDATE
           SET ado_project_id = EXCLUDED.ado_project_id,
               url = EXCLUDED.url,
               metadata = EXCLUDED.metadata,
               config = EXCLUDED.config,
               updated_at = now()
         RETURNING id`,
        [
          input.adoProjectId ?? null,
          input.organization,
          input.project,
          input.url ?? null,
          json(input.metadata),
          json(input.config),
        ],
      );
      return { id: String(res.rows[0].id) };
    },

    async upsertProjectSync(input) {
      const res = await pool.query(
        `INSERT INTO ado_project_syncs
           (ado_project_id, workspace_integration_id, service, status, plane_project_id,
            credentials, default_label_id, config, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb)
         ON CONFLICT (plane_project_id, ado_project_id) DO UPDATE
           SET workspace_integration_id = EXCLUDED.workspace_integration_id,
               service = EXCLUDED.service,
               status = EXCLUDED.status,
               credentials = EXCLUDED.credentials,
               default_label_id = COALESCE(EXCLUDED.default_label_id, ado_project_syncs.default_label_id),
               config = EXCLUDED.config,
               data = EXCLUDED.data,
               updated_at = now()
         RETURNING id, default_label_id`,
        [
          input.adoProjectId,
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

    async setProjectSyncDefaultLabel(id, labelId) {
      await pool.query(
        `UPDATE ado_project_syncs SET default_label_id = $2, updated_at = now() WHERE id = $1`,
        [id, labelId],
      );
    },

    async getWorkItemSync(org, project, workItemId) {
      const res = await pool.query(
        `SELECT * FROM ado_work_item_syncs
         WHERE ado_org = $1 AND ado_project = $2 AND ado_work_item_id = $3`,
        [org, project, workItemId],
      );
      return res.rows[0] ? rowToWorkItemSync(res.rows[0]) : null;
    },

    async upsertWorkItemSync(input) {
      const res = await pool.query(
        `INSERT INTO ado_work_item_syncs
           (ado_org, ado_project, ado_work_item_id, ado_work_item_url, plane_workspace_slug,
            plane_project_id, plane_issue_id, project_sync_id, last_ado_rev)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (ado_org, ado_project, ado_work_item_id) DO UPDATE
           SET ado_work_item_url = EXCLUDED.ado_work_item_url,
               plane_workspace_slug = EXCLUDED.plane_workspace_slug,
               plane_project_id = EXCLUDED.plane_project_id,
               plane_issue_id = EXCLUDED.plane_issue_id,
               project_sync_id = EXCLUDED.project_sync_id,
               last_ado_rev = EXCLUDED.last_ado_rev,
               updated_at = now()
         RETURNING *`,
        [
          input.adoOrg,
          input.adoProject,
          input.adoWorkItemId,
          input.adoWorkItemUrl ?? null,
          input.planeWorkspaceSlug,
          input.planeProjectId,
          input.planeIssueId,
          input.projectSyncId ?? null,
          input.lastAdoRev,
        ],
      );
      return rowToWorkItemSync(res.rows[0]);
    },

    async recordCommentSync(input) {
      await pool.query(
        `INSERT INTO ado_comment_syncs (ado_comment_id, plane_comment_id, work_item_sync_id)
         VALUES ($1, $2, $3)`,
        [input.adoCommentId ?? null, input.planeCommentId ?? null, input.workItemSyncId],
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
  const adoProjects = new Map<string, { id: string }>();
  const projectSyncs = new Map<string, { id: string; defaultLabelId: string | null }>();
  const workItemSyncs = new Map<string, WorkItemSync>();
  const commentSyncs: RecordCommentSyncInput[] = [];

  const key = (...parts: (string | number)[]): string => parts.join("::");

  return {
    async upsertIntegration(input) {
      const existing = integrations.get(input.provider);
      const id = existing?.id ?? randomUUID();
      integrations.set(input.provider, { id });
      return { id };
    },

    async upsertWorkspaceIntegration(input) {
      const k = key(input.planeWorkspaceSlug, input.integrationId);
      const existing = workspaceIntegrations.get(k);
      const id = existing?.id ?? randomUUID();
      workspaceIntegrations.set(k, { id });
      return { id };
    },

    async upsertAdoProject(input) {
      const k = key(input.organization, input.project);
      const existing = adoProjects.get(k);
      const id = existing?.id ?? randomUUID();
      adoProjects.set(k, { id });
      return { id };
    },

    async upsertProjectSync(input) {
      const k = key(input.planeProjectId, input.adoProjectId);
      const existing = projectSyncs.get(k);
      const id = existing?.id ?? randomUUID();
      const defaultLabelId = input.defaultLabelId ?? existing?.defaultLabelId ?? null;
      projectSyncs.set(k, { id, defaultLabelId });
      return { id, defaultLabelId };
    },

    async setProjectSyncDefaultLabel(id, labelId) {
      for (const [k, value] of projectSyncs) {
        if (value.id === id) projectSyncs.set(k, { id, defaultLabelId: labelId });
      }
    },

    async getWorkItemSync(org, project, workItemId) {
      return workItemSyncs.get(key(org, project, workItemId)) ?? null;
    },

    async upsertWorkItemSync(input) {
      const k = key(input.adoOrg, input.adoProject, input.adoWorkItemId);
      const now = new Date().toISOString();
      const existing = workItemSyncs.get(k);
      const record: WorkItemSync = {
        id: existing?.id ?? randomUUID(),
        ado_org: input.adoOrg,
        ado_project: input.adoProject,
        ado_work_item_id: input.adoWorkItemId,
        ado_work_item_url: input.adoWorkItemUrl ?? null,
        plane_workspace_slug: input.planeWorkspaceSlug,
        plane_project_id: input.planeProjectId,
        plane_issue_id: input.planeIssueId,
        project_sync_id: input.projectSyncId ?? null,
        last_ado_rev: input.lastAdoRev,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      workItemSyncs.set(k, record);
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
