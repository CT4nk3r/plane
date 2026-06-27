import { loadConfig } from "../src/config";
import type { Config } from "../src/config";
import type { Logger } from "../src/logger";

/** A complete, valid environment for tests (hosts are nock-mockable). */
export function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ADO_ORG: "myorg",
    ADO_PROJECT: "myproject",
    ADO_PAT: "test-pat",
    ADO_WEBHOOK_SECRET: "s3cr3t",
    ADO_BASE_URL: "http://ado.test",
    PLANE_BASE_URL: "http://plane.test",
    PLANE_API_KEY: "plane-key",
    PLANE_WORKSPACE_SLUG: "ws",
    PLANE_PROJECT_ID: "proj-1",
    ...overrides,
  };
}

export function loadTestConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig(testEnv(overrides));
}

/** A logger that swallows output, to keep test runs quiet. */
export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => silentLogger,
};
