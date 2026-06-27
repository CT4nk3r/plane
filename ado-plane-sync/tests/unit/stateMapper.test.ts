import { describe, expect, it } from "vitest";
import { resolvePlaneStateName } from "../../src/mappers/stateMapper";

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
