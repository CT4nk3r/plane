/**
 * Plane REST API client (public API, base `/api/v1`, auth header `X-Api-Key`).
 *
 * Implements the integration pattern Plane itself uses: idempotent links via
 * `external_id` + `external_source`, find-or-create for labels/states, and the
 * emulated upsert (GET by external key -> PATCH, else POST, reconciling the
 * 409 "already exists" response). PUT upsert is intentionally not used: it
 * exists on the view but no URL exposes it in this Plane version.
 */

import axios from "axios";
import type { AxiosInstance } from "axios";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { PlaneIssue, PlaneIssuePayload, PlaneLabel, PlaneMember, PlaneState } from "../types";
import { axiosStatus, describeAxiosError } from "./http";

const DEFAULT_LABEL_COLOR = "#6e56cf";

export type CreateIssueResult =
  | { status: "created"; issue: PlaneIssue }
  | { status: "conflict"; id: string };

export interface PlaneClient {
  getWorkItemByExternalId(externalId: string, externalSource: string): Promise<PlaneIssue | null>;
  createIssue(payload: PlaneIssuePayload): Promise<CreateIssueResult>;
  updateIssue(id: string, payload: Partial<PlaneIssuePayload>): Promise<PlaneIssue>;
  findStateByName(name: string): Promise<PlaneState | undefined>;
  ensureLabels(names: string[]): Promise<string[]>;
  ensureLabel(name: string): Promise<string>;
  listMembers(): Promise<PlaneMember[]>;
  addComment(issueId: string, commentHtml: string): Promise<string>;
}

interface Paginated<T> {
  results?: T[];
  next_cursor?: string;
  next_page_results?: boolean;
}

export function createPlaneClient(config: Config, logger: Logger): PlaneClient {
  const { baseUrl, apiKey, workspaceSlug, projectId } = config.plane;
  const externalSource = config.externalSource;

  const http: AxiosInstance = axios.create({
    baseURL: `${baseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/${encodeURIComponent(projectId)}`,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });

  // Lazily-loaded caches (states/members are stable within a process run;
  // the label cache is updated as labels are created).
  let statesCache: PlaneState[] | null = null;
  let labelCache: Map<string, string> | null = null;
  let membersCache: PlaneMember[] | null = null;

  async function fetchAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    // Guard against pathological loops.
    for (let page = 0; page < 1000; page += 1) {
      const params: Record<string, string | number> = { per_page: 100 };
      if (cursor) params.cursor = cursor;
      let data: T[] | Paginated<T>;
      try {
        const res = await http.get(path, { params });
        data = res.data as T[] | Paginated<T>;
      } catch (error) {
        throw new Error(`Plane GET ${path} failed: ${describeAxiosError(error)}`);
      }
      if (Array.isArray(data)) {
        out.push(...data);
        break;
      }
      if (data && Array.isArray(data.results)) {
        out.push(...data.results);
        if (data.next_page_results && data.next_cursor) {
          cursor = data.next_cursor;
          continue;
        }
      }
      break;
    }
    return out;
  }

  async function loadStates(): Promise<PlaneState[]> {
    if (!statesCache) {
      statesCache = await fetchAll<PlaneState>("/states/");
      logger.debug("plane.states.loaded", { count: statesCache.length });
    }
    return statesCache;
  }

  async function loadLabels(): Promise<Map<string, string>> {
    if (!labelCache) {
      const labels = await fetchAll<PlaneLabel>("/labels/");
      labelCache = new Map(labels.map((label) => [label.name.toLowerCase(), label.id]));
    }
    return labelCache;
  }

  async function createLabel(name: string): Promise<string> {
    try {
      const res = await http.post("/labels/", {
        name,
        color: DEFAULT_LABEL_COLOR,
        external_id: name,
        external_source: externalSource,
      });
      return (res.data as PlaneLabel).id;
    } catch (error) {
      if (axiosStatus(error) === 409 && axios.isAxiosError(error)) {
        const existingId = (error.response?.data as { id?: string } | undefined)?.id;
        if (existingId) return existingId;
      }
      throw new Error(`Plane createLabel("${name}") failed: ${describeAxiosError(error)}`);
    }
  }

  async function ensureLabel(name: string): Promise<string> {
    const cache = await loadLabels();
    const key = name.toLowerCase();
    const existing = cache.get(key);
    if (existing) return existing;
    const id = await createLabel(name);
    cache.set(key, id);
    logger.debug("plane.label.created", { name, id });
    return id;
  }

  return {
    async getWorkItemByExternalId(externalId, source): Promise<PlaneIssue | null> {
      try {
        const res = await http.get("/work-items/", {
          params: { external_id: externalId, external_source: source },
        });
        const data = res.data;
        if (data && typeof data === "object" && "id" in data) {
          return data as PlaneIssue;
        }
        return null;
      } catch (error) {
        if (axiosStatus(error) === 404) return null;
        throw new Error(`Plane getWorkItemByExternalId(${externalId}) failed: ${describeAxiosError(error)}`);
      }
    },

    async createIssue(payload): Promise<CreateIssueResult> {
      try {
        const res = await http.post("/work-items/", payload);
        return { status: "created", issue: res.data as PlaneIssue };
      } catch (error) {
        if (axiosStatus(error) === 409 && axios.isAxiosError(error)) {
          const existingId = (error.response?.data as { id?: string } | undefined)?.id;
          if (existingId) return { status: "conflict", id: existingId };
        }
        throw new Error(`Plane createIssue failed: ${describeAxiosError(error)}`);
      }
    },

    async updateIssue(id, payload): Promise<PlaneIssue> {
      try {
        const res = await http.patch(`/work-items/${id}/`, payload);
        return res.data as PlaneIssue;
      } catch (error) {
        throw new Error(`Plane updateIssue(${id}) failed: ${describeAxiosError(error)}`);
      }
    },

    async findStateByName(name): Promise<PlaneState | undefined> {
      const states = await loadStates();
      const lowered = name.toLowerCase();
      return states.find((state) => state.name.toLowerCase() === lowered);
    },

    async ensureLabels(names): Promise<string[]> {
      const ids: string[] = [];
      for (const name of names) {
        if (!name) continue;
        ids.push(await ensureLabel(name));
      }
      return ids;
    },

    ensureLabel,

    async listMembers(): Promise<PlaneMember[]> {
      if (!membersCache) {
        membersCache = await fetchAll<PlaneMember>("/members/");
      }
      return membersCache;
    },

    async addComment(issueId, commentHtml): Promise<string> {
      try {
        const res = await http.post(`/work-items/${issueId}/comments/`, {
          comment_html: commentHtml,
          external_source: externalSource,
        });
        return (res.data as { id: string }).id;
      } catch (error) {
        throw new Error(`Plane addComment(${issueId}) failed: ${describeAxiosError(error)}`);
      }
    },
  };
}
