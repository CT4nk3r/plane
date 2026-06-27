import { describe, expect, it } from "vitest";
import {
  deriveOrgFromUrl,
  parseWorkItemEvent,
  WebhookParseError,
} from "../../src/parsers/azureDevOpsWebhook";
import created from "../fixtures/workitem.created.json";
import updated from "../fixtures/workitem.updated.json";

const fallback = { org: "fallback-org", project: "fallback-project" };

describe("parseWorkItemEvent", () => {
  it("parses a workitem.created payload (flat fields)", () => {
    const event = parseWorkItemEvent(created, fallback);
    expect(event.eventType).toBe("workitem.created");
    expect(event.workItemId).toBe(42);
    expect(event.rev).toBe(1);
    expect(event.project).toBe("myproject");
    expect(event.org).toBe("myorg");
    expect(event.fields["System.Title"]).toBe("Login button is misaligned");
  });

  it("parses a workitem.updated payload using the revision snapshot + workItemId", () => {
    const event = parseWorkItemEvent(updated, fallback);
    expect(event.workItemId).toBe(42);
    expect(event.rev).toBe(4);
    // Flattened from the full revision snapshot, not the {oldValue,newValue} diff.
    expect(event.fields["System.State"]).toBe("Active");
    expect(event.fields["System.Tags"]).toBe("frontend; ui");
  });

  it("falls back to configured org/project when not derivable", () => {
    const event = parseWorkItemEvent(
      { eventType: "workitem.created", resource: { id: 7, rev: 1, fields: {} } },
      fallback,
    );
    expect(event.org).toBe("fallback-org");
    expect(event.project).toBe("fallback-project");
  });

  it("derives the org from a work item URL", () => {
    expect(deriveOrgFromUrl("https://dev.azure.com/myorg/_apis/wit/workItems/42")).toBe("myorg");
    expect(deriveOrgFromUrl("https://myorg.visualstudio.com/project/_apis")).toBe("myorg");
    expect(deriveOrgFromUrl(undefined)).toBeUndefined();
  });

  it("classifies unsupported events", () => {
    expect.assertions(2);
    try {
      parseWorkItemEvent({ eventType: "workitem.deleted", resource: { id: 1 } }, fallback);
    } catch (error) {
      expect(error).toBeInstanceOf(WebhookParseError);
      expect((error as WebhookParseError).code).toBe("unsupported_event");
    }
  });

  it("classifies malformed bodies as invalid", () => {
    expect.assertions(1);
    try {
      parseWorkItemEvent("not-an-object", fallback);
    } catch (error) {
      expect((error as WebhookParseError).code).toBe("invalid");
    }
  });
});
