import { describe, expect, it, vi } from "vitest";
import type { AzureDevOpsClient } from "../../src/clients/azureDevOps";
import type { CreateIssueResult, PlaneClient } from "../../src/clients/plane";
import { createInMemorySyncStore } from "../../src/db";
import type { SyncStore } from "../../src/db";
import { syncWorkItem } from "../../src/sync/workItemSync";
import type { AdoWorkItem, ConnectionContext, ParsedWebhookEvent } from "../../src/types";
import { loadTestConfig, silentLogger } from "../helpers";

function connection(): ConnectionContext {
  return {
    integrationId: "int",
    workspaceIntegrationId: "wi",
    adoProjectId: "ap",
    projectSyncId: "ps",
    service: "azure_devops",
    externalSource: "azure_devops",
    adoOrg: "myorg",
    adoProject: "myproject",
    planeWorkspaceSlug: "ws",
    planeProjectId: "proj-1",
    defaultLabelId: "label-default",
    stateMap: { Active: "In Progress" },
    userMap: [],
  };
}

function event(rev = 4): ParsedWebhookEvent {
  return { eventType: "workitem.updated", workItemId: 42, rev, org: "myorg", project: "myproject", fields: {} };
}

function fakeAdo(rev: number): AzureDevOpsClient {
  const workItem: AdoWorkItem = {
    id: 42,
    rev,
    fields: {
      "System.Title": "Login button is misaligned",
      "System.State": "Active",
      "System.Tags": "frontend",
      "System.AssignedTo": { uniqueName: "dev@example.com" },
    },
    _links: { html: { href: "https://dev.azure.com/myorg/myproject/_workitems/edit/42" } },
  };
  return {
    getWorkItem: vi.fn().mockResolvedValue(workItem),
    addBacklinkComment: vi.fn().mockResolvedValue(1),
  };
}

function fakePlane(overrides: Partial<PlaneClient> = {}): PlaneClient {
  const created: CreateIssueResult = { status: "created", issue: { id: "issue-1" } };
  return {
    findStateByName: vi.fn().mockResolvedValue({ id: "state-1", name: "In Progress" }),
    ensureLabels: vi.fn().mockResolvedValue(["label-frontend"]),
    ensureLabel: vi.fn().mockResolvedValue("label-default"),
    listMembers: vi.fn().mockResolvedValue([{ id: "member-1", email: "dev@example.com" }]),
    getWorkItemByExternalId: vi.fn().mockResolvedValue(null),
    createIssue: vi.fn().mockResolvedValue(created),
    updateIssue: vi.fn().mockResolvedValue({ id: "issue-1" }),
    addComment: vi.fn().mockResolvedValue("comment-1"),
    ...overrides,
  } as unknown as PlaneClient;
}

function deps(store: SyncStore, ado: AzureDevOpsClient, plane: PlaneClient) {
  return { config: loadTestConfig(), connection: connection(), ado, plane, store, logger: silentLogger };
}

describe("syncWorkItem", () => {
  it("creates a Plane issue with mapped state, labels, and assignee", async () => {
    const store = createInMemorySyncStore();
    const plane = fakePlane();
    const outcome = await syncWorkItem(event(), deps(store, fakeAdo(4), plane));

    expect(outcome.action).toBe("created");
    expect(outcome.issueId).toBe("issue-1");

    const payload = (plane.createIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.external_id).toBe("42");
    expect(payload.external_source).toBe("azure_devops");
    expect(payload.state).toBe("state-1");
    expect(payload.assignees).toEqual(["member-1"]);
    expect(payload.labels).toEqual(expect.arrayContaining(["label-frontend", "label-default"]));

    const sync = await store.getWorkItemSync("myorg", "myproject", 42);
    expect(sync?.plane_issue_id).toBe("issue-1");
    expect(sync?.last_ado_rev).toBe(4);
  });

  it("skips when the fetched rev is not newer than the recorded rev", async () => {
    const store = createInMemorySyncStore();
    await store.upsertWorkItemSync({
      adoOrg: "myorg",
      adoProject: "myproject",
      adoWorkItemId: 42,
      planeWorkspaceSlug: "ws",
      planeProjectId: "proj-1",
      planeIssueId: "issue-1",
      lastAdoRev: 5,
    });
    const plane = fakePlane();
    const outcome = await syncWorkItem(event(6), deps(store, fakeAdo(5), plane));

    expect(outcome.action).toBe("skipped");
    expect(plane.createIssue).not.toHaveBeenCalled();
    expect(plane.updateIssue).not.toHaveBeenCalled();
  });

  it("updates the mapped Plane issue when a mapping already exists", async () => {
    const store = createInMemorySyncStore();
    await store.upsertWorkItemSync({
      adoOrg: "myorg",
      adoProject: "myproject",
      adoWorkItemId: 42,
      planeWorkspaceSlug: "ws",
      planeProjectId: "proj-1",
      planeIssueId: "issue-1",
      lastAdoRev: 1,
    });
    const plane = fakePlane();
    const outcome = await syncWorkItem(event(4), deps(store, fakeAdo(4), plane));

    expect(outcome.action).toBe("updated");
    expect(plane.updateIssue).toHaveBeenCalledWith("issue-1", expect.anything());
    expect(plane.getWorkItemByExternalId).not.toHaveBeenCalled();
    expect((await store.getWorkItemSync("myorg", "myproject", 42))?.last_ado_rev).toBe(4);
  });

  it("reconciles a 409 conflict by updating the existing issue", async () => {
    const store = createInMemorySyncStore();
    const plane = fakePlane({
      createIssue: vi.fn().mockResolvedValue({ status: "conflict", id: "issue-9" }),
    });
    const outcome = await syncWorkItem(event(4), deps(store, fakeAdo(4), plane));

    expect(outcome.action).toBe("updated");
    expect(outcome.issueId).toBe("issue-9");
    expect(plane.updateIssue).toHaveBeenCalledWith("issue-9", expect.anything());
  });
});
