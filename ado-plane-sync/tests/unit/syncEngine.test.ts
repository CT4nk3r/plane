import { describe, expect, it, vi } from "vitest";
import type { CreateIssueResult, PlaneClient } from "../../src/clients/plane";
import type { Connector, MappedEntity, NormalizedEvent } from "../../src/connectors/types";
import { createInMemorySyncStore } from "../../src/db";
import type { SyncStore } from "../../src/db";
import { syncEntity } from "../../src/sync/syncEngine";
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
    defaultLabelId: "label-default",
    stateMap: { Active: "In Progress" },
    userMap: [],
  };
}

function event(): NormalizedEvent {
  return {
    provider: "azure_devops",
    eventType: "workitem.updated",
    externalId: "42",
    externalRev: 4,
    org: "myorg",
    project: "myproject",
    raw: {},
  };
}

function fakeConnector(rev: number): Connector {
  const mapped: MappedEntity = {
    name: "Login button is misaligned",
    descriptionHtml: "<p>desc</p>",
    stateName: "In Progress",
    tags: ["frontend", "Bug"],
    assignee: { uniqueName: "dev@example.com" },
    priority: "high",
    cycleName: "Sprint 1",
    externalId: "42",
    externalSource: "azure_devops",
    externalUrl: "https://dev.azure.com/myorg/myproject/_workitems/edit/42",
    externalRev: rev,
  };
  return {
    provider: "azure_devops",
    webhookSlug: "azure-devops",
    parseWebhook: vi.fn(),
    fetchEntity: vi.fn().mockResolvedValue(mapped),
    addBacklink: vi.fn().mockResolvedValue(1),
    listEntities: vi.fn().mockResolvedValue([]),
  };
}

function fakePlane(overrides: Partial<PlaneClient> = {}): PlaneClient {
  const created: CreateIssueResult = { status: "created", issue: { id: "issue-1" } };
  return {
    findStateByName: vi.fn().mockResolvedValue({ id: "state-1", name: "In Progress" }),
    ensureState: vi.fn().mockResolvedValue("state-1"),
    ensureLabels: vi.fn().mockResolvedValue(["label-frontend", "label-bug"]),
    ensureLabel: vi.fn().mockResolvedValue("label-default"),
    ensureCycle: vi.fn().mockResolvedValue("cycle-1"),
    addIssueToCycle: vi.fn().mockResolvedValue(undefined),
    listMembers: vi.fn().mockResolvedValue([{ id: "member-1", email: "dev@example.com" }]),
    getWorkItemByExternalId: vi.fn().mockResolvedValue(null),
    createIssue: vi.fn().mockResolvedValue(created),
    updateIssue: vi.fn().mockResolvedValue({ id: "issue-1" }),
    addComment: vi.fn().mockResolvedValue("comment-1"),
    ...overrides,
  } as unknown as PlaneClient;
}

function deps(store: SyncStore, plane: PlaneClient) {
  return { config: loadTestConfig(), connection: connection(), plane, store, logger: silentLogger };
}

describe("syncEntity", () => {
  it("creates a Plane issue with mapped state, labels, and assignee", async () => {
    const store = createInMemorySyncStore();
    const plane = fakePlane();
    const outcome = await syncEntity(fakeConnector(4), event(), deps(store, plane));

    expect(outcome.action).toBe("created");
    expect(outcome.issueId).toBe("issue-1");
    expect(outcome.provider).toBe("azure_devops");

    const payload = (plane.createIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.external_id).toBe("42");
    expect(payload.external_source).toBe("azure_devops");
    expect(payload.state).toBe("state-1");
    expect(payload.priority).toBe("high");
    expect(payload.assignees).toEqual(["member-1"]);
    expect(payload.labels).toEqual(expect.arrayContaining(["label-frontend", "label-default"]));

    expect(plane.ensureCycle).toHaveBeenCalledWith("Sprint 1");
    expect(plane.addIssueToCycle).toHaveBeenCalledWith("cycle-1", "issue-1");

    const sync = await store.getEntitySync("azure_devops", "myorg", "myproject", "42");
    expect(sync?.plane_issue_id).toBe("issue-1");
    expect(sync?.external_rev).toBe(4);
  });

  it("skips when the fetched rev is not newer than the recorded rev", async () => {
    const store = createInMemorySyncStore();
    await store.upsertEntitySync({
      provider: "azure_devops",
      externalOrg: "myorg",
      externalProject: "myproject",
      externalId: "42",
      planeWorkspaceSlug: "ws",
      planeProjectId: "proj-1",
      planeIssueId: "issue-1",
      externalRev: 5,
    });
    const plane = fakePlane();
    const outcome = await syncEntity(fakeConnector(5), event(), deps(store, plane));

    expect(outcome.action).toBe("skipped");
    expect(plane.createIssue).not.toHaveBeenCalled();
    expect(plane.updateIssue).not.toHaveBeenCalled();
  });

  it("updates the mapped Plane issue when a mapping already exists", async () => {
    const store = createInMemorySyncStore();
    await store.upsertEntitySync({
      provider: "azure_devops",
      externalOrg: "myorg",
      externalProject: "myproject",
      externalId: "42",
      planeWorkspaceSlug: "ws",
      planeProjectId: "proj-1",
      planeIssueId: "issue-1",
      externalRev: 1,
    });
    const plane = fakePlane();
    const outcome = await syncEntity(fakeConnector(4), event(), deps(store, plane));

    expect(outcome.action).toBe("updated");
    expect(plane.updateIssue).toHaveBeenCalledWith("issue-1", expect.anything());
    expect(plane.getWorkItemByExternalId).not.toHaveBeenCalled();
    expect((await store.getEntitySync("azure_devops", "myorg", "myproject", "42"))?.external_rev).toBe(4);
  });

  it("reconciles a 409 conflict by updating the existing issue", async () => {
    const store = createInMemorySyncStore();
    const plane = fakePlane({
      createIssue: vi.fn().mockResolvedValue({ status: "conflict", id: "issue-9" }),
    });
    const outcome = await syncEntity(fakeConnector(4), event(), deps(store, plane));

    expect(outcome.action).toBe("updated");
    expect(outcome.issueId).toBe("issue-9");
    expect(plane.updateIssue).toHaveBeenCalledWith("issue-9", expect.anything());
  });
});
