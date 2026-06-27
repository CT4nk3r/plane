import { describe, expect, it, vi } from "vitest";
import type { PlaneClient } from "../../src/clients/plane";
import { bootstrapConnection } from "../../src/connection";
import { createInMemorySyncStore } from "../../src/db";
import { loadTestConfig, silentLogger } from "../helpers";

function fakePlane(ensureLabel: PlaneClient["ensureLabel"]): PlaneClient {
  return { ensureLabel } as unknown as PlaneClient;
}

describe("bootstrapConnection", () => {
  it("seeds the layered rows and ensures the default sync label", async () => {
    const store = createInMemorySyncStore();
    const ensureLabel = vi.fn().mockResolvedValue("label-default");
    const config = loadTestConfig();

    const ctx = await bootstrapConnection(config, store, fakePlane(ensureLabel), silentLogger);

    expect(ensureLabel).toHaveBeenCalledWith("Azure DevOps");
    expect(ctx.service).toBe("azure_devops");
    expect(ctx.externalSource).toBe("azure_devops");
    expect(ctx.adoOrg).toBe("myorg");
    expect(ctx.adoProject).toBe("myproject");
    expect(ctx.planeWorkspaceSlug).toBe("ws");
    expect(ctx.planeProjectId).toBe("proj-1");
    expect(ctx.defaultLabelId).toBe("label-default");
    expect(ctx.integrationId).toBeTruthy();
    expect(ctx.workspaceIntegrationId).toBeTruthy();
    expect(ctx.adoProjectId).toBeTruthy();
    expect(ctx.projectSyncId).toBeTruthy();
    expect(ctx.stateMap.Active).toBe("In Progress");
  });

  it("continues without a default label when Plane is unreachable", async () => {
    const store = createInMemorySyncStore();
    const ensureLabel = vi.fn().mockRejectedValue(new Error("plane down"));

    const ctx = await bootstrapConnection(loadTestConfig(), store, fakePlane(ensureLabel), silentLogger);

    expect(ctx.defaultLabelId).toBeNull();
  });

  it("passes the configured user map through to the connection", async () => {
    const store = createInMemorySyncStore();
    const userMap = JSON.stringify([{ username: "dev@example.com", import: "map", email: "dev@example.com" }]);
    const config = loadTestConfig({ USER_MAP_JSON: userMap });

    const ctx = await bootstrapConnection(config, store, fakePlane(vi.fn().mockResolvedValue("l")), silentLogger);

    expect(ctx.userMap).toHaveLength(1);
    expect(ctx.userMap[0].email).toBe("dev@example.com");
  });
});
