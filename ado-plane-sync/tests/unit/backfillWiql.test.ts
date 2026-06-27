import { describe, expect, it } from "vitest";
import { buildWorkItemWiql } from "../../src/connectors/azureDevOpsBackfill";

const PROJECT = "MyProject";

describe("buildWorkItemWiql", () => {
  it("scopes to the current user (assigned-to-me / created-by-me)", () => {
    expect(buildWorkItemWiql("assigned-to-me", PROJECT)).toContain("[System.AssignedTo] = @Me");
    expect(buildWorkItemWiql("created-by-me", PROJECT)).toContain("[System.CreatedBy] = @Me");
  });

  it("scopes to a named user and escapes quotes", () => {
    expect(buildWorkItemWiql("assigned-to:dev@example.com", PROJECT)).toContain(
      "[System.AssignedTo] = 'dev@example.com'",
    );
    expect(buildWorkItemWiql("assigned-to:O'Brien", PROJECT)).toContain("'O''Brien'");
  });

  it("filters active work items", () => {
    const wiql = buildWorkItemWiql("active", PROJECT);
    expect(wiql).toContain("[System.State] NOT IN (");
    expect(wiql).toContain("'Done'");
    expect(wiql).toContain("'Closed'");
  });

  it("filters recent work items with a default and custom window", () => {
    expect(buildWorkItemWiql("recent", PROJECT)).toContain("[System.ChangedDate] >= @Today - 14");
    expect(buildWorkItemWiql("recent:30", PROJECT)).toContain("[System.ChangedDate] >= @Today - 30");
  });

  it("scopes to a sprint and area under the project", () => {
    expect(buildWorkItemWiql("sprint:Sprint 3", PROJECT)).toContain(
      "[System.IterationPath] UNDER 'MyProject\\Sprint 3'",
    );
    expect(buildWorkItemWiql("area:Web", PROJECT)).toContain("[System.AreaPath] UNDER 'MyProject\\Web'");
  });

  it("supports a whole-project pull and a raw query", () => {
    const all = buildWorkItemWiql("all", PROJECT);
    expect(all).toContain("[System.TeamProject] = @project");
    expect(all).not.toContain(" AND ");
    expect(buildWorkItemWiql("query:SELECT [System.Id] FROM workitems", PROJECT)).toBe(
      "SELECT [System.Id] FROM workitems",
    );
  });

  it("rejects an unknown scope", () => {
    expect(() => buildWorkItemWiql("nonsense", PROJECT)).toThrow(/Unknown backfill scope/);
  });
});
