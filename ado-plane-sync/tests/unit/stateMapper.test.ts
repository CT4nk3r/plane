import { describe, expect, it } from "vitest";
import { inferStateGroup, resolvePlaneStateName } from "../../src/mappers/stateMapper";

const stateMap = { New: "Backlog", Active: "In Progress", Resolved: "Done", Closed: "Done" };

describe("resolvePlaneStateName", () => {
  it("maps a known ADO state to the Plane state name", () => {
    expect(resolvePlaneStateName("Active", stateMap)).toBe("In Progress");
    expect(resolvePlaneStateName("Closed", stateMap)).toBe("Done");
  });

  it("matches case-insensitively", () => {
    expect(resolvePlaneStateName("active", stateMap)).toBe("In Progress");
    expect(resolvePlaneStateName("NEW", stateMap)).toBe("Backlog");
  });

  it("falls back to the raw state name when unmapped", () => {
    expect(resolvePlaneStateName("In Review", stateMap)).toBe("In Review");
  });

  it("returns undefined for empty/missing input", () => {
    expect(resolvePlaneStateName("", stateMap)).toBeUndefined();
    expect(resolvePlaneStateName(undefined, stateMap)).toBeUndefined();
    expect(resolvePlaneStateName(null, stateMap)).toBeUndefined();
  });
});

describe("inferStateGroup", () => {
  it("maps a real ADO kanban board's columns to sensible Plane groups", () => {
    const columns = {
      "To Do": "unstarted",
      Development: "started",
      "Test needed": "started",
      Testing: "started",
      Integration: "started",
      Done: "completed",
    } as const;
    for (const [name, group] of Object.entries(columns)) {
      expect(inferStateGroup(name, {}, "started")).toBe(group);
    }
  });

  it("honors an explicit group override (case-insensitive)", () => {
    expect(inferStateGroup("Integration", { integration: "completed" }, "started")).toBe("completed");
  });

  it("classifies cancelled-like and backlog-like names", () => {
    expect(inferStateGroup("Removed", {}, "started")).toBe("cancelled");
    expect(inferStateGroup("New", {}, "started")).toBe("backlog");
  });

  it("falls back to the configured default", () => {
    expect(inferStateGroup("Something Custom", {}, "unstarted")).toBe("unstarted");
  });
});
