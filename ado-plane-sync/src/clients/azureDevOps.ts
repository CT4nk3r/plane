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

export interface AzureDevOpsClient {
  getWorkItem(id: number): Promise<AdoWorkItem>;
  addBacklinkComment(id: number, text: string): Promise<number | null>;
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
        return res.data as AdoWorkItem;
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
  };
}
