/**
 * Connection bootstrap. Mirrors Plane's "install integration -> connect repo to
 * project" flow, but driven by env (the env is the single connection for this
 * MVP). Seeds the layered rows (integration -> workspace_integration ->
 * ado_project -> ado_project_sync) with the native importer-shaped JSON
 * (metadata / config / data) and ensures the default sync label exists, then
 * returns the ConnectionContext the worker uses per job.
 */

import type { PlaneClient } from "./clients/plane";
import type { Config } from "./config";
import type { SyncStore } from "./db";
import type { Logger } from "./logger";
import type { ConnectionContext } from "./types";

export async function bootstrapConnection(
  config: Config,
  store: SyncStore,
  plane: PlaneClient,
  logger: Logger,
): Promise<ConnectionContext> {
  const integration = await store.upsertIntegration({
    provider: config.service,
    webhookSecret: config.ado.webhookSecret,
    metadata: { provider: config.service },
  });

  const workspaceIntegration = await store.upsertWorkspaceIntegration({
    integrationId: integration.id,
    planeWorkspaceSlug: config.plane.workspaceSlug,
    planeApiToken: config.plane.apiKey,
    actor: config.service,
    config: { state_map: config.stateMap },
    metadata: {},
  });

  const adoProject = await store.upsertAdoProject({
    organization: config.ado.org,
    project: config.ado.project,
    url: `${config.ado.baseUrl}/${config.ado.org}/${config.ado.project}`,
    // Native IImporterService.metadata shape (mirrors GitHub {owner,name,repository_id,url}).
    metadata: {
      organization: config.ado.org,
      project: config.ado.project,
      url: `${config.ado.baseUrl}/${config.ado.org}/${config.ado.project}`,
    },
    config: { sync: true },
  });

  // Ensure the default sync label exists (mirrors GithubRepositorySync.label).
  // Best-effort: if Plane is briefly unreachable at boot, continue without it.
  let defaultLabelId: string | null = null;
  try {
    defaultLabelId = await plane.ensureLabel(config.defaultLabelName);
  } catch (error) {
    logger.warn("connection.default_label.failed", {
      label: config.defaultLabelName,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const projectSync = await store.upsertProjectSync({
    adoProjectId: adoProject.id,
    workspaceIntegrationId: workspaceIntegration.id,
    service: config.service,
    status: "completed",
    planeProjectId: config.plane.projectId,
    // Do not persist the raw PAT; record only that PAT auth is configured.
    credentials: { auth: "pat" },
    defaultLabelId,
    config: { sync: true, state_map: config.stateMap },
    // Native data.users user mapping.
    data: { users: config.userMap },
  });

  logger.info("connection.bootstrapped", {
    service: config.service,
    adoOrg: config.ado.org,
    adoProject: config.ado.project,
    planeWorkspaceSlug: config.plane.workspaceSlug,
    planeProjectId: config.plane.projectId,
    defaultLabelId,
  });

  return {
    integrationId: integration.id,
    workspaceIntegrationId: workspaceIntegration.id,
    adoProjectId: adoProject.id,
    projectSyncId: projectSync.id,
    service: config.service,
    externalSource: config.externalSource,
    adoOrg: config.ado.org,
    adoProject: config.ado.project,
    planeWorkspaceSlug: config.plane.workspaceSlug,
    planeProjectId: config.plane.projectId,
    defaultLabelId: projectSync.defaultLabelId ?? defaultLabelId,
    stateMap: config.stateMap,
    userMap: config.userMap,
  };
}
