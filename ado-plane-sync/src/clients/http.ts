/**
 * Small shared helpers for axios-based clients.
 */

import axios from "axios";

/** Produce a concise, log-safe description of an axios/HTTP error. */
export function describeAxiosError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data;
    const body = typeof data === "string" ? data : data ? JSON.stringify(data) : "";
    if (status) {
      return `HTTP ${status}${body ? ` ${body.slice(0, 500)}` : ""}`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Extract the HTTP status code from an axios error, if present. */
export function axiosStatus(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}
