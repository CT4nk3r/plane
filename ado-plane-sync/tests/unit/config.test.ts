import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { testEnv } from "../helpers";

describe("loadConfig", () => {
  it("parses a valid environment and applies defaults", () => {
    const config = loadConfig(testEnv());
    expect(config.service).toBe("azure_devops");
    expect(config.externalSource).toBe("azure_devops");
    expect(config.defaultLabelName).toBe("Azure DevOps");
    expect(config.port).toBe(3100);
    expect(config.worker).toEqual({ enabled: true, maxRetries: 5 });
    expect(config.stateMap.New).toBe("Backlog");
    expect(config.ado.backlinkEnabled).toBe(false);
  });

  it("throws when required variables are missing", () => {
    expect(() => loadConfig({ ADO_ORG: "only-this" })).toThrow(/Invalid configuration/);
  });

  it("throws on malformed STATE_MAP_JSON", () => {
    expect(() => loadConfig(testEnv({ STATE_MAP_JSON: "{ not json" }))).toThrow(/STATE_MAP_JSON/);
  });

  it("parses the native USER_MAP_JSON shape", () => {
    const config = loadConfig(
      testEnv({ USER_MAP_JSON: JSON.stringify([{ username: "a", import: "map", email: "a@b.com" }]) }),
    );
    expect(config.userMap).toHaveLength(1);
    expect(config.userMap[0].import).toBe("map");
  });

  it("normalizes trailing slashes on base URLs", () => {
    const config = loadConfig(testEnv({ PLANE_BASE_URL: "http://plane.test/", ADO_BASE_URL: "http://ado.test/" }));
    expect(config.plane.baseUrl).toBe("http://plane.test");
    expect(config.ado.baseUrl).toBe("http://ado.test");
  });
});
