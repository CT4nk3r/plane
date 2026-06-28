import { afterEach, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import request from "supertest";
import { createPlaneClient } from "../../src/clients/plane";
import { buildConnectorRegistry } from "../../src/connectors/registry";
import { createInMemorySyncStore } from "../../src/db";
import { createInMemoryJobQueue } from "../../src/queue";
import { createApp } from "../../src/server";
import { createWorker } from "../../src/worker";
import type { ConnectionContext } from "../../src/types";
import adoWorkItem from "../fixtures/adoWorkItem.json";
import { loadTestConfig, silentLogger } from "../helpers";

const PLANE_HOST = "http://plane.test";
const PLANE_BASE = "/api/v1/workspaces/ws/projects/proj-1";
const ADO_HOST = "http://ado.test";
const ADO_BASE = "/myorg/myproject/_apis/wit";

function adoItem(rev: number): Record<string, unknown> {
  return { ...adoWorkItem, rev };
}

function webhookBody(rev: number): Record<string, unknown> {
  return {
    eventType: "workitem.updated",
    resource: {
      id: 42,
      workItemId: 42,
      rev,
      revision: { id: 42, rev, fields: { "System.Title": "placeholder" } },
    },
    resourceContainers: { project: { id: "project-guid" } },
  };
}

function harness() {
  const config = loadTestConfig({ STATE_MAP_JSON: '{"Active":"In Progress"}' });
  const store = createInMemorySyncStore();
  const queue = createInMemoryJobQueue();
  const plane = createPlaneClient(config, silentLogger);
  const registry = buildConnectorRegistry(config, silentLogger);
  const connection: ConnectionContext = {
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
    stateMap: config.stateMap,
    userMap: [],
  };
  const app = createApp({ config, registry, queue, logger: silentLogger });
  const worker = createWorker({
    queue,
    registry,
    maxRetries: config.worker.maxRetries,
    logger: silentLogger,
    syncDeps: { config, connection, plane, store, logger: silentLogger },
  });
  return { app, worker, store };
}

function mockPlaneReads(): void {
  nock(PLANE_HOST)
    .get(`${PLANE_BASE}/states/`)
    .query(true)
    .reply(200, { results: [{ id: "state-1", name: "In Progress", group: "started" }] })
    .persist();
  nock(PLANE_HOST)
    .get(`${PLANE_BASE}/members/`)
    .query(true)
    .reply(200, [{ id: "member-1", email: "dev@example.com" }])
    .persist();
  nock(PLANE_HOST).get(`${PLANE_BASE}/labels/`).query(true).reply(200, { results: [] }).persist();
}

beforeEach(() => {
  nock.cleanAll();
});

afterEach(() => {
  nock.cleanAll();
});

describe("POST /webhooks/:provider", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const { app } = harness();
    const res = await request(app).post("/webhooks/azure-devops").send(webhookBody(1));
    expect(res.status).toBe(401);
  });

  it("404s for an unknown provider", async () => {
    const { app } = harness();
    const res = await request(app)
      .post("/webhooks/jira")
      .set("X-Webhook-Secret", "s3cr3t")
      .send(webhookBody(1));
    expect(res.status).toBe(404);
  });

  it("ignores unsupported event types", async () => {
    const { app } = harness();
    const res = await request(app)
      .post("/webhooks/azure-devops")
      .set("X-Webhook-Secret", "s3cr3t")
      .send({ eventType: "workitem.deleted", resource: { id: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
  });

  it("enqueues then syncs through create -> stale-skip -> update", async () => {
    const { app, worker, store } = harness();
    mockPlaneReads();

    // --- create ---
    let createBody: Record<string, unknown> = {};
    nock(ADO_HOST).get(`${ADO_BASE}/workitems/42`).query(true).reply(200, adoItem(3));
    nock(PLANE_HOST)
      .get(`${PLANE_BASE}/work-items/`)
      .query((q) => q.external_id === "42")
      .reply(404, {});
    // Tags + the work-item-type label ("Bug") are find-or-created dynamically.
    nock(PLANE_HOST)
      .post(`${PLANE_BASE}/labels/`)
      .reply(201, (_uri, body: { name?: string }) => ({
        id: `label-${String(body.name).toLowerCase()}`,
        name: body.name,
      }))
      .persist();
    nock(PLANE_HOST)
      .post(`${PLANE_BASE}/work-items/`, (b) => {
        createBody = b;
        return true;
      })
      .reply(201, { id: "issue-1" });

    const res = await request(app)
      .post("/webhooks/azure-devops")
      .set("X-Webhook-Secret", "s3cr3t")
      .send(webhookBody(3));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.provider).toBe("azure_devops");

    const created = await worker.processOnce();
    expect(created && "outcome" in created ? created.outcome.action : null).toBe("created");
    expect(createBody.external_id).toBe("42");
    expect(createBody.external_source).toBe("azure_devops");
    expect(createBody.state).toBe("state-1");
    expect(createBody.assignees).toEqual(["member-1"]);
    expect(createBody.labels).toEqual(
      expect.arrayContaining(["label-default", "label-frontend", "label-bug"]),
    );
    expect(createBody.name).toBe("Login button is misaligned");

    let sync = await store.getEntitySync("azure_devops", "myorg", "myproject", "42");
    expect(sync?.plane_issue_id).toBe("issue-1");
    expect(sync?.external_rev).toBe(3);

    // --- stale skip (ADO still at rev 3) ---
    nock(ADO_HOST).get(`${ADO_BASE}/workitems/42`).query(true).reply(200, adoItem(3));
    await request(app).post("/webhooks/azure-devops").set("X-Webhook-Secret", "s3cr3t").send(webhookBody(4));
    const skipped = await worker.processOnce();
    expect(skipped && "outcome" in skipped ? skipped.outcome.action : null).toBe("skipped");
    expect((await store.getEntitySync("azure_devops", "myorg", "myproject", "42"))?.external_rev).toBe(3);

    // --- update (ADO advanced to rev 6) ---
    let patchBody: Record<string, unknown> = {};
    nock(ADO_HOST).get(`${ADO_BASE}/workitems/42`).query(true).reply(200, adoItem(6));
    nock(PLANE_HOST)
      .patch(`${PLANE_BASE}/work-items/issue-1/`, (b) => {
        patchBody = b;
        return true;
      })
      .reply(200, { id: "issue-1" });

    await request(app).post("/webhooks/azure-devops").set("X-Webhook-Secret", "s3cr3t").send(webhookBody(5));
    const updated = await worker.processOnce();
    expect(updated && "outcome" in updated ? updated.outcome.action : null).toBe("updated");
    expect(patchBody.external_id).toBe("42");

    sync = await store.getEntitySync("azure_devops", "myorg", "myproject", "42");
    expect(sync?.external_rev).toBe(6);
  });
});
