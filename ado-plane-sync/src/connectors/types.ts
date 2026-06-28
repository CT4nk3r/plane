/**
 * Connector abstraction — the seam that makes this a multi-provider sync service
 * (mirroring how Plane's "Silo" integrations service hosts many providers behind
 * one engine). Each provider implements a `Connector`; the generic sync engine
 * drives them all via `external_id`/`external_source` upserts into Plane.
 *
 * To add a provider: implement `Connector` (parse its webhook, fetch + map an
 * entity, optionally post a backlink) and register it in `registry.ts`.
 */

import type { ConnectionContext, ExternalUserRef, PlaneIssueEvent, PlanePriority } from "../types";

export type WebhookParseErrorCode = "unsupported_event" | "invalid";

export class WebhookParseError extends Error {
  readonly code: WebhookParseErrorCode;
  constructor(message: string, code: WebhookParseErrorCode = "invalid") {
    super(message);
    this.name = "WebhookParseError";
    this.code = code;
  }
}

/** A provider webhook normalized to the minimum the engine needs to act. */
export interface NormalizedEvent {
  provider: string;
  eventType: string;
  externalId: string;
  externalRev: number;
  org: string;
  project: string;
  /** The original payload (kept for the durable job; fetch is authoritative). */
  raw: unknown;
}

/** A provider entity mapped to provider-neutral fields the engine resolves. */
export interface MappedEntity {
  name: string;
  descriptionHtml?: string;
  /** Target Plane state name (already run through the connection's state map). */
  stateName?: string;
  /** Label names (e.g. from tags, work item type). */
  tags: string[];
  assignee: ExternalUserRef | null;
  priority?: PlanePriority;
  /** Sprint/cycle name to ensure + assign, if any. */
  cycleName?: string;
  /** Parent entity's external id, for best-effort parent linking. */
  parentExternalId?: string;
  externalId: string;
  externalSource: string;
  externalUrl?: string;
  externalRev: number;
}

export interface Connector {
  /** Stable provider slug written to Plane `external_source` (e.g. "azure_devops"). */
  readonly provider: string;
  /** URL segment for `POST /webhooks/:slug` (e.g. "azure-devops"). */
  readonly webhookSlug: string;
  /** Parse + normalize an inbound provider webhook. */
  parseWebhook(body: unknown, fallback: { org: string; project: string }): NormalizedEvent;
  /** Fetch the authoritative entity from the provider and map it to neutral fields. */
  fetchEntity(event: NormalizedEvent, ctx: ConnectionContext): Promise<MappedEntity>;
  /** Best-effort backlink on the source entity; returns the comment id or null. */
  addBacklink(event: NormalizedEvent, planeIssueUrl: string, ctx: ConnectionContext): Promise<number | null>;
  /** Enumerate entities to backfill for a scope (e.g. "assigned-to-me"). */
  listEntities(scope: string, ctx: ConnectionContext): Promise<NormalizedEvent[]>;
  /** Optional reverse (Plane -> provider) write capability. */
  readonly reverse?: ReverseConnector;
}

/** A Plane issue mapped to provider-neutral fields for a reverse (Plane -> external) write. */
export interface ReverseMappedItem {
  title: string;
  descriptionHtml?: string;
  /** Target external state name (already mapped from Plane); omit to use the type's default. */
  stateName?: string;
  areaPath?: string;
  iterationPath?: string;
}

export interface ReverseWriteOptions {
  /** Parent work item's external id, for hierarchy linking. */
  parentExternalId?: string;
  /** Resolved assignee identity (e.g. email) for the external system. */
  assigneeEmail?: string;
}

export interface ReverseWriteResult {
  externalId: string;
  externalRev: number;
  url?: string;
}

/**
 * The reverse half of a connector: create/update the provider's work item from
 * a Plane issue. The generic reverse engine owns orchestration (loop guards,
 * external-id stamping, watermarks); the connector owns the provider specifics.
 */
export interface ReverseConnector {
  /** Map a Plane issue event to neutral external fields (pure). */
  mapPlaneIssue(event: PlaneIssueEvent): ReverseMappedItem;
  /** Create the external work item; returns its id, rev, and html url. */
  createExternalItem(item: ReverseMappedItem, opts: ReverseWriteOptions): Promise<ReverseWriteResult>;
  /** Update the external work item; returns the new rev. */
  updateExternalItem(
    externalId: string,
    item: ReverseMappedItem,
    opts: ReverseWriteOptions,
  ): Promise<{ externalRev: number }>;
}
