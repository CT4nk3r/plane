import { describe, expect, it } from "vitest";
import { buildConnectorRegistry } from "../../src/connectors/registry";
import created from "../fixtures/workitem.created.json";
import { loadTestConfig, silentLogger } from "../helpers";

describe("connector registry", () => {
  it("registers the Azure DevOps connector by slug and provider", () => {
    const registry = buildConnectorRegistry(loadTestConfig(), silentLogger);
    expect(registry.all).toHaveLength(1);

    const bySlug = registry.bySlug.get("azure-devops");
    const byProvider = registry.byProvider.get("azure_devops");
    expect(bySlug).toBeDefined();
    expect(byProvider).toBe(bySlug);
    expect(bySlug?.provider).toBe("azure_devops");
    expect(registry.bySlug.get("unknown")).toBeUndefined();
  });

  it("normalizes an ADO webhook through the connector", () => {
    const registry = buildConnectorRegistry(loadTestConfig(), silentLogger);
    const connector = registry.bySlug.get("azure-devops");
    const event = connector!.parseWebhook(created, { org: "fallback", project: "fallback" });

    expect(event.provider).toBe("azure_devops");
    expect(event.externalId).toBe("42");
    expect(event.externalRev).toBe(1);
    expect(event.org).toBe("myorg");
    expect(event.project).toBe("myproject");
  });
});
