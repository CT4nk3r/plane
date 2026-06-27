import { describe, expect, it } from "vitest";
import { mapWorkItem, normalizeAdoUser, parseTags } from "../../src/mappers/workItemMapper";
import type { AdoWorkItem } from "../../src/types";
import adoWorkItem from "../fixtures/adoWorkItem.json";

const stateMap = { Active: "In Progress" };

describe("mapWorkItem", () => {
  it("extracts and normalizes ADO fields", () => {
    const mapped = mapWorkItem(adoWorkItem as unknown as AdoWorkItem, {
      stateMap,
      externalSource: "azure_devops",
    });
    expect(mapped.name).toBe("Login button is misaligned");
    expect(mapped.stateName).toBe("In Progress");
    expect(mapped.tags).toEqual(["frontend"]);
    expect(mapped.assignee?.uniqueName).toBe("dev@example.com");
    expect(mapped.workItemType).toBe("Bug");
    expect(mapped.externalId).toBe("42");
    expect(mapped.externalSource).toBe("azure_devops");
    expect(mapped.url).toContain("/_workitems/edit/42");
    expect(mapped.descriptionHtml).toContain("login button");
  });

  it("falls back to a generated name when Title is missing", () => {
    const mapped = mapWorkItem({ id: 9, rev: 1, fields: {} }, { stateMap, externalSource: "azure_devops" });
    expect(mapped.name).toBe("Work item 9");
    expect(mapped.tags).toEqual([]);
    expect(mapped.assignee).toBeNull();
  });
});

describe("parseTags", () => {
  it("splits a semicolon-separated tag string", () => {
    expect(parseTags("a; b;c ")).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for non-strings", () => {
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags(null)).toEqual([]);
  });
});

describe("normalizeAdoUser", () => {
  it("handles the modern object form", () => {
    expect(normalizeAdoUser({ uniqueName: "x@y.com", displayName: "X" })?.uniqueName).toBe("x@y.com");
  });

  it("handles the 'Name <email>' string form", () => {
    const user = normalizeAdoUser("Dev One <dev@example.com>");
    expect(user?.displayName).toBe("Dev One");
    expect(user?.uniqueName).toBe("dev@example.com");
  });

  it("returns null for empty input", () => {
    expect(normalizeAdoUser(null)).toBeNull();
    expect(normalizeAdoUser("")).toBeNull();
  });
});
