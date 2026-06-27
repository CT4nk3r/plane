import { describe, expect, it } from "vitest";
import { createInMemorySyncStore } from "../../src/db";
import { createInMemoryJobQueue } from "../../src/queue";

describe("InMemorySyncStore", () => {
  it("creates and updates a provider-keyed entity sync mapping", async () => {
    const store = createInMemorySyncStore();
    expect(await store.getEntitySync("azure_devops", "o", "p", "1")).toBeNull();

    const created = await store.upsertEntitySync({
      provider: "azure_devops",
      externalOrg: "o",
      externalProject: "p",
      externalId: "1",
      planeWorkspaceSlug: "w",
      planeProjectId: "pr",
      planeIssueId: "i1",
      externalRev: 2,
    });
    expect(created.plane_issue_id).toBe("i1");
    expect((await store.getEntitySync("azure_devops", "o", "p", "1"))?.external_rev).toBe(2);

    const updated = await store.upsertEntitySync({
      provider: "azure_devops",
      externalOrg: "o",
      externalProject: "p",
      externalId: "1",
      planeWorkspaceSlug: "w",
      planeProjectId: "pr",
      planeIssueId: "i1",
      externalRev: 5,
    });
    expect(updated.id).toBe(created.id);
    expect((await store.getEntitySync("azure_devops", "o", "p", "1"))?.external_rev).toBe(5);
  });

  it("isolates mappings by provider", async () => {
    const store = createInMemorySyncStore();
    await store.upsertEntitySync({
      provider: "azure_devops",
      externalOrg: "o",
      externalProject: "p",
      externalId: "1",
      planeWorkspaceSlug: "w",
      planeProjectId: "pr",
      planeIssueId: "ado-issue",
      externalRev: 1,
    });
    expect(await store.getEntitySync("github", "o", "p", "1")).toBeNull();
    expect((await store.getEntitySync("azure_devops", "o", "p", "1"))?.plane_issue_id).toBe("ado-issue");
  });

  it("preserves the default label across project connection upserts", async () => {
    const store = createInMemorySyncStore();
    const first = await store.upsertProjectConnection({
      provider: "azure_devops",
      externalProjectId: "ep",
      workspaceIntegrationId: "wi",
      service: "azure_devops",
      planeProjectId: "pr",
      defaultLabelId: "lbl",
    });
    expect(first.defaultLabelId).toBe("lbl");

    const second = await store.upsertProjectConnection({
      provider: "azure_devops",
      externalProjectId: "ep",
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
