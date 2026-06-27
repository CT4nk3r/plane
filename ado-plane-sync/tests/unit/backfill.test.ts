import { describe, expect, it, vi } from "vitest";
import type { PlaneClient } from "../../src/clients/plane";
import type { Connector, MappedEntity, NormalizedEvent } from "../../src/connectors/types";
import { runBackfill } from "../../src/backfill";
import { createInMemorySyncStore } from "../../src/db";
import type { SyncStore } from "../../src/db";
import type { ConnectionContext } from "../../src/types";
import { loadTestConfig, silentLogger } from "../helpers";

function connection(): ConnectionContext {
  return {
    integrationId: "int",
    workspaceIntegrationId: "wi",
    externalProjectId: "ep",
    projectConnectionId: "pc",
    provider: "azure_devops",
    externalSource: "azure_devops",
    externalOrg: "myorg",
    externalProject: "myproject",
    planeWorkspaceSlug: "ws",
    planeProjectId: "proj-1",
    defaultLabelId: null,
    stateMap: {},
    userMap: [],
  };
}

function eventsFor(ids: string[]): NormalizedEvent[] {
  return ids.map((id) => ({
    provider: "azure_devops",
    eventType: "backfill",
    externalId: id,
    externalRev: 0,
    org: "myorg",
    project: "myproject",
    raw: {},
  }));
}

function makeConnector(events: NormalizedEvent[], failIds: string[] = []): Connector {
  return {
    provider: "azure_devops",
    webhookSlug: "azure-devops",
    parseWebhook: vi.fn(),
    addBacklink: vi.fn().mockResolvedValue(null),
    listEntities: vi.fn().mockResolvedValue(events),
    fetchEntity: vi.fn().mockImplementation((event: NormalizedEvent) => {
      if (failIds.includes(event.externalId)) {
        return Promise.reject(new Error(`fetch failed for ${event.externalId}`));
      }
      const mapped: MappedEntity = {
        name: `WI ${event.externalId}`,
        tags: [],
        assignee: null,
        externalId: event.externalId,
        externalSource: "azure_devops",
        externalRev: 1,
      };
      return Promise.resolve(mapped);
    }),
  };
}

function fakePlane(): PlaneClient {
  return {
    findStateByName: vi.fn().mockResolvedValue(undefined),
    ensureState: vi.fn().mockResolvedValue(undefined),
    ensureLabels: vi.fn().mockResolvedValue([]),
    ensureLabel: vi.fn().mockResolvedValue("label-default"),
    ensureCycle: vi.fn().mockResolvedValue(undefined),
    addIssueToCycle: vi.fn().mockResolvedValue(undefined),
    listMembers: vi.fn().mockResolvedValue([]),
    getWorkItemByExternalId: vi.fn().mockResolvedValue(null),
    createIssue: vi
      .fn()
      .mockImplementation((payload: { external_id: string }) =>
        Promise.resolve({ status: "created", issue: { id: `issue-${payload.external_id}` } }),
      ),
    updateIssue: vi.fn().mockImplementation((id: string) => Promise.resolve({ id })),
    addComment: vi.fn().mockResolvedValue("comment-1"),
  } as unknown as PlaneClient;
}

function deps(store: SyncStore, plane: PlaneClient) {
  return { config: loadTestConfig(), connection: connection(), plane, store, logger: silentLogger };
}

describe("runBackfill", () => {
  it("syncs every entity for a scope and summarizes", async () => {
    const store = createInMemorySyncStore();
    const connector = makeConnector(eventsFor(["1", "2", "3"]));
    const summary = await runBackfill(connector, deps(store, fakePlane()), {
      scope: "all",
      limit: 100,
      concurrency: 2,
    });

    expect(connector.listEntities).toHaveBeenCalledWith("all", expect.anything());
    expect(summary.found).toBe(3);
    expect(summary.processed).toBe(3);
    expect(summary.created).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.truncated).toBe(false);
    expect(await store.getEntitySync("azure_devops", "myorg", "myproject", "2")).not.toBeNull();
  });

  it("respects the limit (truncates) and is idempotent on re-run", async () => {
    const store = createInMemorySyncStore();
    const limited = await runBackfill(makeConnector(eventsFor(["1", "2", "3", "4", "5"])), deps(store, fakePlane()), {
      scope: "active",
      limit: 2,
      concurrency: 1,
    });
    expect(limited.found).toBe(5);
    expect(limited.processed).toBe(2);
    expect(limited.truncated).toBe(true);

    // Re-running over already-synced items skips them (rev guard).
    const again = await runBackfill(makeConnector(eventsFor(["1", "2"])), deps(store, fakePlane()), {
      scope: "active",
      limit: 100,
      concurrency: 2,
    });
    expect(again.skipped).toBe(2);
    expect(again.created).toBe(0);
  });

  it("records per-item failures without aborting the run", async () => {
    const store = createInMemorySyncStore();
    const summary = await runBackfill(makeConnector(eventsFor(["1", "2", "3"]), ["2"]), deps(store, fakePlane()), {
      scope: "all",
      limit: 100,
      concurrency: 3,
    });
    expect(summary.created).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.errors[0].externalId).toBe("2");
  });
});
