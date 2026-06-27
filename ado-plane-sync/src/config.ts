/**
 * Environment configuration, validated with zod. The env is effectively the
 * single "installation/connection" for this MVP (one ADO project <-> one Plane
 * project), carrying the native importer-shaped inputs: state map, user map,
 * provider slug, and the bot API token.
 */

import { z } from "zod";
import type { LogLevel } from "./logger";
import type { PlaneStateGroup, UserMapEntry } from "./types";

const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;

const booleanString = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

const stateMapSchema = z.record(z.string(), z.string());
const stateGroupMapSchema = z.record(z.string(), z.enum(STATE_GROUPS));

const userMapSchema = z.array(
  z.object({
    username: z.string(),
    import: z.union([z.literal("map"), z.literal("invite"), z.literal(false)]),
    email: z.string(),
  }),
);

const envSchema = z.object({
  // Azure DevOps
  ADO_ORG: z.string().min(1, "ADO_ORG is required"),
  ADO_PROJECT: z.string().min(1, "ADO_PROJECT is required"),
  ADO_PAT: z.string().min(1, "ADO_PAT is required"),
  ADO_WEBHOOK_SECRET: z.string().min(1, "ADO_WEBHOOK_SECRET is required"),
  ADO_BASE_URL: z.string().url().default("https://dev.azure.com"),
  ADO_API_VERSION: z.string().min(1).default("7.0"),
  ADO_BACKLINK_ENABLED: booleanString.default(false),

  // Plane
  PLANE_BASE_URL: z.string().url(),
  PLANE_API_KEY: z.string().min(1, "PLANE_API_KEY is required"),
  PLANE_WORKSPACE_SLUG: z.string().min(1, "PLANE_WORKSPACE_SLUG is required"),
  PLANE_PROJECT_ID: z.string().min(1, "PLANE_PROJECT_ID is required"),

  // Mapping / native integration shape
  STATE_MAP_JSON: z.string().default("{}"),
  STATE_GROUP_MAP_JSON: z.string().default("{}"),
  DEFAULT_STATE_GROUP: z.enum(STATE_GROUPS).default("started"),
  AUTO_CREATE_STATES: booleanString.default(true),
  SERVICE: z.string().min(1).default("azure_devops"),
  EXTERNAL_SOURCE: z.string().min(1).default("azure_devops"),
  DEFAULT_LABEL_NAME: z.string().min(1).default("Azure DevOps"),
  USER_MAP_JSON: z.string().default("[]"),

  // What to pull in (all on by default for a full trial)
  SYNC_WORK_ITEM_TYPE_AS_LABEL: booleanString.default(true),
  TYPE_LABEL_PREFIX: z.string().default(""),
  SYNC_ITERATIONS_AS_CYCLES: booleanString.default(true),
  SYNC_PARENT: booleanString.default(true),
  SYNC_PRIORITY: booleanString.default(true),

  // Service / database
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().min(1).optional(),
  WORKER_ENABLED: booleanString.default(true),
  WORKER_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
});

export interface Config {
  ado: {
    org: string;
    project: string;
    pat: string;
    webhookSecret: string;
    baseUrl: string;
    apiVersion: string;
    backlinkEnabled: boolean;
  };
  plane: {
    baseUrl: string;
    apiKey: string;
    workspaceSlug: string;
    projectId: string;
  };
  service: string;
  externalSource: string;
  defaultLabelName: string;
  stateMap: Record<string, string>;
  stateGroupMap: Record<string, PlaneStateGroup>;
  defaultStateGroup: PlaneStateGroup;
  autoCreateStates: boolean;
  userMap: UserMapEntry[];
  sync: {
    workItemTypeAsLabel: boolean;
    typeLabelPrefix: string;
    iterationsAsCycles: boolean;
    parent: boolean;
    priority: boolean;
  };
  port: number;
  databaseUrl?: string;
  worker: {
    enabled: boolean;
    maxRetries: number;
  };
  logLevel: LogLevel;
}

function parseJson<T>(raw: string, schema: z.ZodType<T>, varName: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${varName} must be valid JSON`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${varName} is invalid: ${result.error.issues.map((i) => i.message).join(", ")}`);
  }
  return result.data;
}

/**
 * Load and validate configuration. Throws an aggregated, human-readable error
 * if any required variable is missing or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n  ");
    throw new Error(`Invalid configuration:\n  ${details}`);
  }

  const e = parsed.data;
  const stateMap = parseJson(e.STATE_MAP_JSON, stateMapSchema, "STATE_MAP_JSON");
  const stateGroupMap = parseJson(e.STATE_GROUP_MAP_JSON, stateGroupMapSchema, "STATE_GROUP_MAP_JSON");
  const userMap = parseJson(e.USER_MAP_JSON, userMapSchema, "USER_MAP_JSON");

  return {
    ado: {
      org: e.ADO_ORG,
      project: e.ADO_PROJECT,
      pat: e.ADO_PAT,
      webhookSecret: e.ADO_WEBHOOK_SECRET,
      baseUrl: e.ADO_BASE_URL.replace(/\/+$/, ""),
      apiVersion: e.ADO_API_VERSION,
      backlinkEnabled: e.ADO_BACKLINK_ENABLED,
    },
    plane: {
      baseUrl: e.PLANE_BASE_URL.replace(/\/+$/, ""),
      apiKey: e.PLANE_API_KEY,
      workspaceSlug: e.PLANE_WORKSPACE_SLUG,
      projectId: e.PLANE_PROJECT_ID,
    },
    service: e.SERVICE,
    externalSource: e.EXTERNAL_SOURCE,
    defaultLabelName: e.DEFAULT_LABEL_NAME,
    stateMap,
    stateGroupMap,
    defaultStateGroup: e.DEFAULT_STATE_GROUP,
    autoCreateStates: e.AUTO_CREATE_STATES,
    userMap,
    sync: {
      workItemTypeAsLabel: e.SYNC_WORK_ITEM_TYPE_AS_LABEL,
      typeLabelPrefix: e.TYPE_LABEL_PREFIX,
      iterationsAsCycles: e.SYNC_ITERATIONS_AS_CYCLES,
      parent: e.SYNC_PARENT,
      priority: e.SYNC_PRIORITY,
    },
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    worker: {
      enabled: e.WORKER_ENABLED,
      maxRetries: e.WORKER_MAX_RETRIES,
    },
    logLevel: e.LOG_LEVEL,
  };
}
