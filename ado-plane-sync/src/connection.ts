/**
 * Connection bootstrap. Mirrors Plane's "install integration -> connect project"
 * flow, driven by env (the env is the single connection for this MVP). Seeds the
 * provider-agnostic layered rows (integration -> workspace_integration ->
 * external_project -> project_connection) with the native importer-shaped JSON
 * (metadata / config / data) and ensures the default sync label exists, then
 * returns the ConnectionContext the engine uses per job.
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
  const provider = config.service;

  const integration = await store.upsertIntegration({
    provider,
    webhookSecret: config.ado.webhookSecret,
    metadata: { provider },
  });

  const workspaceIntegration = await store.upsertWorkspaceIntegration({
    integrationId: integration.id,
    planeWorkspaceSlug: config.plane.workspaceSlug,
    planeApiToken: config.plane.apiKey,
    actor: provider,
    config: { state_map: config.stateMap },
    metadata: {},
  });

  const externalProjectUrl = `${config.ado.baseUrl}/${config.ado.org}/${config.ado.project}`;
  const externalProject = await store.upsertExternalProject({
    provider,
    organization: config.ado.org,
    project: config.ado.project,
    url: externalProjectUrl,
    // Native IImporterService.metadata shape (mirrors GitHub {owner,name,repository_id,url}).
    metadata: {
      organization: config.ado.org,
      project: config.ado.project,
      url: externalProjectUrl,
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

  const projectConnection = await store.upsertProjectConnection({
    provider,
    externalProjectId: externalProject.id,
    workspaceIntegrationId: workspaceIntegration.id,
    service: provider,
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
    provider,
    externalOrg: config.ado.org,
    externalProject: config.ado.project,
    planeWorkspaceSlug: config.plane.workspaceSlug,
    planeProjectId: config.plane.projectId,
    defaultLabelId,
  });

  return {
    integrationId: integration.id,
    workspaceIntegrationId: workspaceIntegration.id,
    externalProjectId: externalProject.id,
    projectConnectionId: projectConnection.id,
    provider,
    externalSource: config.externalSource,
    externalOrg: config.ado.org,
    externalProject: config.ado.project,
    planeWorkspaceSlug: config.plane.workspaceSlug,
    planeProjectId: config.plane.projectId,
    defaultLabelId: projectConnection.defaultLabelId ?? defaultLabelId,
    stateMap: config.stateMap,
    userMap: config.userMap,
  };
}
