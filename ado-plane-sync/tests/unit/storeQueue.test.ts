import { describe, expect, it } from "vitest";
import { createInMemorySyncStore } from "../../src/db";
import { createInMemoryJobQueue } from "../../src/queue";

describe("InMemorySyncStore", () => {
  it("creates and updates a work item sync mapping", async () => {
    const store = createInMemorySyncStore();
    expect(await store.getWorkItemSync("o", "p", 1)).toBeNull();

    const created = await store.upsertWorkItemSync({
      adoOrg: "o",
      adoProject: "p",
      adoWorkItemId: 1,
      planeWorkspaceSlug: "w",
      planeProjectId: "pr",
      planeIssueId: "i1",
      lastAdoRev: 2,
    });
    expect(created.plane_issue_id).toBe("i1");
    expect((await store.getWorkItemSync("o", "p", 1))?.last_ado_rev).toBe(2);

    const updated = await store.upsertWorkItemSync({
      adoOrg: "o",
      adoProject: "p",
      adoWorkItemId: 1,
      planeWorkspaceSlug: "w",
      planeProjectId: "pr",
      planeIssueId: "i1",
      lastAdoRev: 5,
    });
    expect(updated.id).toBe(created.id);
    expect((await store.getWorkItemSync("o", "p", 1))?.last_ado_rev).toBe(5);
  });

  it("preserves the default label across project sync upserts", async () => {
    const store = createInMemorySyncStore();
    const first = await store.upsertProjectSync({
      adoProjectId: "ap",
      workspaceIntegrationId: "wi",
      service: "azure_devops",
      planeProjectId: "pr",
      defaultLabelId: "lbl",
    });
    expect(first.defaultLabelId).toBe("lbl");

    const second = await store.upsertProjectSync({
      adoProjectId: "ap",
      workspaceIntegrationId: "wi",
      service: "azure_devops",
      planeProjectId: "pr",
    });
    expect(second.id).toBe(first.id);
    expect(second.defaultLabelId).toBe("lbl");
  });
});

describe("InMemoryJobQueue", () => {
  it("enqueues, dedupes active keys, claims, and completes", async () => {
    const queue = createInMemoryJobQueue();

    const first = await queue.enqueue({ dedupeKey: "k1", eventType: "e", payload: { x: 1 } });
    expect(first.enqueued).toBe(true);

    const duplicate = await queue.enqueue({ dedupeKey: "k1", eventType: "e", payload: { x: 1 } });
    expect(duplicate.enqueued).toBe(false);

    const job = await queue.claimNext();
    expect(job?.dedupe_key).toBe("k1");
    expect(job?.attempts).toBe(1);
    expect(await queue.claimNext()).toBeNull();

    await queue.complete(job!.id);
  });

  it("requeues on retry and stops retrying when exhausted", async () => {
    const queue = createInMemoryJobQueue();
    await queue.enqueue({ dedupeKey: "k", eventType: "e", payload: {} });

    const job = await queue.claimNext();
    await queue.fail(job!.id, { error: "boom", nextAttemptAt: new Date(Date.now() - 1000), exhausted: false });

    const retried = await queue.claimNext();
    expect(retried?.id).toBe(job!.id);
    expect(retried?.attempts).toBe(2);

    await queue.fail(retried!.id, { error: "boom", nextAttemptAt: new Date(), exhausted: true });
    expect(await queue.claimNext()).toBeNull();
  });
});
