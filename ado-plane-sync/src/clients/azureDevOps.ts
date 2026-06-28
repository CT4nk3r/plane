/**
 * Azure DevOps REST client. Authenticates with a Personal Access Token via
 * HTTP Basic ("Authorization: Basic base64(':' + PAT)"). Scoped to a single
 * org/project (this MVP syncs one connection).
 */

import axios from "axios";
import type { AxiosInstance } from "axios";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { AdoWorkItem } from "../types";
import { describeAxiosError } from "./http";

/** A single Azure DevOps JSON-Patch operation (Content-Type application/json-patch+json). */
export interface AdoPatchOp {
  op: "add" | "replace" | "remove" | "test";
  path: string;
  value?: unknown;
}

export interface AzureDevOpsClient {
  getWorkItem(id: number): Promise<AdoWorkItem>;
  addBacklinkComment(id: number, text: string): Promise<number | null>;
  /** Run a WIQL query and return the matching work item ids. */
  queryWorkItemIds(wiql: string): Promise<number[]>;
  /** Create a work item of `type` from a JSON-Patch document. */
  createWorkItem(type: string, ops: AdoPatchOp[]): Promise<AdoWorkItem>;
  /** Update a work item by id from a JSON-Patch document. */
  updateWorkItem(id: number, ops: AdoPatchOp[]): Promise<AdoWorkItem>;
}

export function createAzureDevOpsClient(config: Config, logger: Logger): AzureDevOpsClient {
  const { org, project, pat, baseUrl, apiVersion } = config.ado;
  const token = Buffer.from(`:${pat}`).toString("base64");

  const http: AxiosInstance = axios.create({
    baseURL: `${baseUrl}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit`,
    headers: {
      Authorization: `Basic ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });

  return {
    async getWorkItem(id: number): Promise<AdoWorkItem> {
      try {
        const res = await http.get(`/workitems/${id}`, {
          params: { $expand: "all", "api-version": apiVersion },
        });
        const data = res.data as AdoWorkItem;
        if (!data || typeof data.id !== "number") {
          throw new Error("unexpected response shape (check PAT scope and org/project)");
        }
        return data;
      } catch (error) {
        throw new Error(`ADO getWorkItem(${id}) failed: ${describeAxiosError(error)}`);
      }
    },

    async addBacklinkComment(id: number, text: string): Promise<number | null> {
      try {
        const res = await http.post(
          `/workItems/${id}/comments`,
          { text },
          { params: { "api-version": `${apiVersion}-preview.4` } },
        );
        logger.debug("ado.backlink.posted", { workItemId: id });
        const commentId = (res.data as { id?: unknown })?.id;
        return typeof commentId === "number" ? commentId : null;
      } catch (error) {
        // Backlink is best-effort; log but don't fail the sync.
        logger.warn("ado.backlink.failed", { workItemId: id, error: describeAxiosError(error) });
        return null;
      }
    },

    async queryWorkItemIds(wiql: string): Promise<number[]> {
      try {
        const res = await http.post(
          "/wiql",
          { query: wiql },
          { params: { "api-version": apiVersion } },
        );
        const items = (res.data as { workItems?: { id?: unknown }[] }).workItems ?? [];
        return items
          .map((item) => item.id)
          .filter((id): id is number => typeof id === "number");
      } catch (error) {
        throw new Error(`ADO WIQL query failed: ${describeAxiosError(error)}`);
      }
    },

    async createWorkItem(type: string, ops: AdoPatchOp[]): Promise<AdoWorkItem> {
      try {
        const res = await http.post(`/workitems/$${encodeURIComponent(type)}`, ops, {
          params: { "api-version": apiVersion },
          headers: { "Content-Type": "application/json-patch+json" },
        });
        const data = res.data as AdoWorkItem;
        if (!data || typeof data.id !== "number") {
          throw new Error("unexpected response shape (check PAT scope: Work Items Read & Write)");
        }
        logger.debug("ado.workitem.created", { id: data.id, type });
        return data;
      } catch (error) {
        throw new Error(`ADO createWorkItem(${type}) failed: ${describeAxiosError(error)}`);
      }
    },

    async updateWorkItem(id: number, ops: AdoPatchOp[]): Promise<AdoWorkItem> {
      try {
        const res = await http.patch(`/workitems/${id}`, ops, {
          params: { "api-version": apiVersion },
          headers: { "Content-Type": "application/json-patch+json" },
        });
        const data = res.data as AdoWorkItem;
        if (!data || typeof data.id !== "number") {
          throw new Error("unexpected response shape (check PAT scope: Work Items Read & Write)");
        }
        logger.debug("ado.workitem.updated", { id, rev: data.rev });
        return data;
      } catch (error) {
        throw new Error(`ADO updateWorkItem(${id}) failed: ${describeAxiosError(error)}`);
      }
    },
  };
}
