import { describe, expect, it } from "vitest";
import { extractEmail, resolveAssigneeId } from "../../src/mappers/userMapper";
import type { PlaneMember, UserMapEntry } from "../../src/types";

const members: PlaneMember[] = [
  { id: "m1", email: "dev@example.com" },
  { id: "m2", email: "qa@example.com" },
];

describe("extractEmail", () => {
  it("reads uniqueName", () => {
    expect(extractEmail({ uniqueName: "dev@example.com" })).toBe("dev@example.com");
  });

  it("reads an email embedded in a display string", () => {
    expect(extractEmail({ displayName: "Dev One <dev@example.com>" })).toBe("dev@example.com");
  });

  it("returns undefined when there is no email", () => {
    expect(extractEmail({ displayName: "Dev One" })).toBeUndefined();
    expect(extractEmail(null)).toBeUndefined();
  });
});

describe("resolveAssigneeId", () => {
  it("auto-matches by email when no userMap entry exists", () => {
    expect(resolveAssigneeId({ uniqueName: "dev@example.com" }, [], members)).toBe("m1");
  });

  it("returns null when no Plane member matches", () => {
    expect(resolveAssigneeId({ uniqueName: "nobody@example.com" }, [], members)).toBeNull();
  });

  it("skips users mapped with import=false", () => {
    const userMap: UserMapEntry[] = [{ username: "dev@example.com", import: false, email: "dev@example.com" }];
    expect(resolveAssigneeId({ uniqueName: "dev@example.com" }, userMap, members)).toBeNull();
  });

  it("skips users mapped with import=invite (not supported in v1)", () => {
    const userMap: UserMapEntry[] = [{ username: "dev@example.com", import: "invite", email: "dev@example.com" }];
    expect(resolveAssigneeId({ uniqueName: "dev@example.com" }, userMap, members)).toBeNull();
  });

  it("maps to the configured Plane email when import=map", () => {
    const userMap: UserMapEntry[] = [{ username: "old@example.com", import: "map", email: "qa@example.com" }];
    expect(resolveAssigneeId({ uniqueName: "old@example.com" }, userMap, members)).toBe("m2");
  });

  it("returns null when there is no assignee", () => {
    expect(resolveAssigneeId(null, [], members)).toBeNull();
  });
});
