# ado-plane-sync

A multi-provider sync service that ingests external Service Hook / webhook events
and syncs them into **Plane** as work items (issues). It runs alongside Plane and
talks to Plane's public REST API — **Plane itself is not modified**.

It's structured the way Plane's own integrations service ("Silo") is: a generic
sync **engine** plus per-provider **connectors**. **Azure DevOps**
(`workitem.created` / `workitem.updated`) is the first connector; adding GitHub,
GitLab, Jira, etc. is a new connector module + one registry line.

It deliberately follows the conventions shared by Plane's own **GitHub**
integration and **Jira** importer.

---

## How it mirrors Plane's integrations

| Plane convention (real) | Where it lives in Plane | What this service does |
| --- | --- | --- |
| `external_id` + `external_source` as the idempotent link on every entity | `apps/api/.../db/models/issue.py`, label/state; create returns **409 + existing id** on duplicate | Every synced issue/label is written with `external_source="azure_devops"`, `external_id="<ado id>"` |
| Layered sync model `Integration → WorkspaceIntegration → *Repository/Project → *IssueSync → *CommentSync` | `db/models/integration/github.py` | `integrations → workspace_integrations → external_projects → project_connections → entity_item_syncs → entity_comment_syncs` |
| Importer connection shape `{ service, status, config, metadata, data }` with `data.users` user mapping | `packages/types/src/importer` (`IImporterService`, jira/github importers) | `project_connections` stores `service`, `status`, `config` (`{sync, state_map}`); `external_projects.metadata` holds `{organization, project, url}`; `data` holds `{users}` |
| Bot **actor + API token** used for all writes | `WorkspaceIntegration.actor` + `api_token` | `PLANE_API_KEY` is the bot/service-account token |
| Default sync label applied to every synced issue | `GithubRepositorySync.label` | `DEFAULT_LABEL_NAME` is find-or-created and attached to every synced issue |
| Async webhook processing with retries | Celery `webhook_send_task` (`retry_backoff`, `max_retries=5`) | Durable `sync_jobs` queue + worker with exponential backoff, `WORKER_MAX_RETRIES` |
| Status lifecycle `queued → processing → completed → failed` | `Importer.status` | `sync_jobs.status` |

> Note: Plane's public API exposes a `put()` upsert on the view, but **no URL
> routes `PUT`** in the current version, so this service emulates the upsert the
> supported way: `GET ?external_id&external_source` → `PATCH`, else `POST`,
> reconciling the 409 "already exists" response.

---

## Architecture

```
Provider webhook ──HTTP──▶ POST /webhooks/:provider   (e.g. /webhooks/azure-devops)
                              │  auth: Basic or X-Webhook-Secret
                              ▼
                     registry → connector.parseWebhook ──▶ enqueue sync_jobs ──▶ 202
                                                      │
                          worker (poll, retry)        ▼
                     connector.fetchEntity  (fetch authoritative entity + map)
                                                      │
                          engine: resolve state/labels/assignee
                                                      │
                     upsert Plane issue (external_id/external_source)
                                                      │
                          record entity_item_syncs (+ optional backlink)
```

Source layout (`src/`):
- **Generic core:** `config`, `logger`, `types`, `db` (schema + stores), `queue`,
  `connection` (bootstrap), `clients/plane`, `sync/syncEngine`, `worker`,
  `routes/webhook`, `server`, `index`.
- **Connectors:** `connectors/types` (the `Connector` interface + registry shape),
  `connectors/registry` (which providers exist), `connectors/azureDevOps`.
- **ADO building blocks** used by the ADO connector: `parsers/azureDevOpsWebhook`,
  `clients/azureDevOps`, `mappers/{stateMapper,userMapper,workItemMapper}`.

### Adding a provider

1. Implement `Connector` (`connectors/types.ts`): `parseWebhook`, `fetchEntity`
   (fetch + map to neutral fields), and `addBacklink`.
2. Register it in `connectors/registry.ts`.

That's it — the engine, queue, worker, schema, and `POST /webhooks/:provider`
routing are all provider-agnostic.

---

## What gets pulled in

For each ADO work item (Bug, Task, User Story, Epic, Feature, Issue, **Test Case**, …):

- **Title / description** → Plane issue name / description.
- **Board column / state** → Plane state, **created on the fly** if it doesn't exist
  yet. Your columns (e.g. *To Do, Development, Test needed, Testing, Integration,
  Done*) appear in Plane automatically — no manual state setup. The Plane state
  *group* is inferred from the column name (e.g. Done→completed, To Do→unstarted,
  else `DEFAULT_STATE_GROUP`); override per column with `STATE_GROUP_MAP_JSON`.
- **Work item type** (Bug, User Story, Test Case, …) → a Plane **label**, so you
  can filter by type. Toggle with `SYNC_WORK_ITEM_TYPE_AS_LABEL`.
- **Tags** → Plane labels (find-or-create) + the default sync label.
- **Iteration / Sprint** (`System.IterationPath`) → a Plane **Cycle**
  (find-or-create + assign). Toggle with `SYNC_ITERATIONS_AS_CYCLES`.
- **Priority** (1–4) → Plane priority (urgent/high/medium/low).
- **Assignee** → Plane member (auto-matched by email, or via `USER_MAP_JSON`).
- **Parent** → best-effort Plane parent link once the parent is also synced.

> Test **cases** are ADO work items, so they sync like everything else (with a
> "Test Case" type label). Test **plans/suites** are separate ADO test-management
> entities (not work items) and aren't synced yet — see *Limitations*.

---

## Prerequisites

1. **A Plane bot/service user + API token.** Create a dedicated user in your
   Plane workspace, add it to the target project, and generate an API key
   (Workspace settings → API tokens). This token is `PLANE_API_KEY` and mirrors
   `WorkspaceIntegration.api_token`.
2. **The target Plane workspace slug and project id** (`PLANE_WORKSPACE_SLUG`,
   `PLANE_PROJECT_ID`).
3. **An Azure DevOps PAT** with *Work Items (Read)* scope (`ADO_PAT`).
4. **A webhook secret** (`ADO_WEBHOOK_SECRET`) — any long random string.

---

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env — fill in ADO_* and PLANE_* values
docker compose up --build
```

This starts Postgres and the sync service on **http://localhost:3100**.
Check health: `curl localhost:3100/health`.

Then register an Azure DevOps Service Hook (see below) pointing at
`http://<host>:3100/webhooks/azure-devops`.

---

## Configuration

All variables are read by `src/config.ts` (validated with zod). See
[`.env.example`](./.env.example) for the annotated list.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ADO_ORG` | yes | — | Azure DevOps organization |
| `ADO_PROJECT` | yes | — | Azure DevOps project |
| `ADO_PAT` | yes | — | PAT with Work Items (Read) |
| `ADO_WEBHOOK_SECRET` | yes | — | Shared secret for inbound webhooks |
| `ADO_BASE_URL` | no | `https://dev.azure.com` | ADO REST base URL |
| `ADO_API_VERSION` | no | `7.0` | ADO REST API version |
| `ADO_BACKLINK_ENABLED` | no | `false` | Post a backlink comment on the ADO work item |
| `PLANE_BASE_URL` | yes | — | Plane instance base URL (no `/api/v1`) |
| `PLANE_API_KEY` | yes | — | Plane bot API token |
| `PLANE_WORKSPACE_SLUG` | yes | — | Target Plane workspace slug |
| `PLANE_PROJECT_ID` | yes | — | Target Plane project UUID |
| `STATE_MAP_JSON` | no | `{}` | Optional rename of ADO state → Plane state name (else used as-is) |
| `AUTO_CREATE_STATES` | no | `true` | Create missing Plane states from ADO columns |
| `STATE_GROUP_MAP_JSON` | no | `{}` | Override the Plane group per state name |
| `DEFAULT_STATE_GROUP` | no | `started` | Group when a state's group can't be inferred |
| `SYNC_WORK_ITEM_TYPE_AS_LABEL` / `TYPE_LABEL_PREFIX` | no | `true` / `""` | Add work item type as a label |
| `SYNC_ITERATIONS_AS_CYCLES` | no | `true` | Pull sprints into Plane Cycles |
| `SYNC_PARENT` | no | `true` | Best-effort parent linking |
| `SYNC_PRIORITY` | no | `true` | Map ADO priority → Plane priority |
| `SERVICE` / `EXTERNAL_SOURCE` | no | `azure_devops` | Provider slug written to Plane |
| `DEFAULT_LABEL_NAME` | no | `Azure DevOps` | Default label applied to every synced issue |
| `USER_MAP_JSON` | no | `[]` | `[{username, import: "map"\|"invite"\|false, email}]` |
| `PORT` | no | `3100` | HTTP port |
| `DATABASE_URL` | no | (in-memory) | Postgres connection string |
| `WORKER_ENABLED` | no | `true` | Run the background worker in-process |
| `WORKER_MAX_RETRIES` | no | `5` | Max retries before a job is marked failed |
| `LOG_LEVEL` | no | `info` | `error` / `warn` / `info` / `debug` |

If `DATABASE_URL` is omitted the service uses a non-durable in-memory store —
useful for a quick demo, but use Postgres for anything real.

---

## Register the Azure DevOps Service Hook

In your ADO project: **Project settings → Service hooks → + → Web Hooks**.

1. **Trigger:** *Work item created* (repeat for *Work item updated*).
2. **Action → URL:** `http://<host>:3100/webhooks/azure-devops`
3. **Authentication** — choose one:
   - **Basic auth:** set the password to your `ADO_WEBHOOK_SECRET` (username is ignored), or
   - **HTTP headers:** add `X-Webhook-Secret: <ADO_WEBHOOK_SECRET>`.
4. Leave the resource details at defaults and finish.

The endpoint returns `202` when a job is queued, `200 {"status":"ignored"}` for
unsupported event types, `400` for malformed payloads, `401` when the secret is
missing/invalid, and `404` for an unknown provider slug.

---

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe; returns the registered providers |
| `POST` | `/webhooks/:provider` | Receives a provider's webhook (e.g. `/webhooks/azure-devops`) |

---

## Data model

`ensureSchema()` creates these provider-agnostic tables on boot (idempotent);
every per-provider row carries a `provider` column:

- `integrations`, `workspace_integrations` — the provider + workspace install
- `external_projects`, `project_connections` — the connected external project ↔ Plane project
- `entity_item_syncs` — external entity ↔ Plane issue mapping (`external_rev` drives idempotency)
- `entity_comment_syncs` — backlink/comment mapping
- `sync_jobs` — the durable webhook queue (the provider travels in the job payload)

---

## Local development

```bash
pnpm install
pnpm dev            # tsx watch (set env via your shell or a .env + --env-file)
pnpm check:types    # tsc --noEmit
pnpm test           # vitest (unit + integration, fully mocked — no network/db)
pnpm build          # tsc -> dist/
```

Tests use an in-memory store/queue and mock ADO + Plane HTTP with `nock`, so they
need no database or network.

---

## Limitations (v1)

- **One connection per instance** — a single ADO project ↔ Plane project, driven
  by env. Multiple connections is a natural extension (more rows, mirroring
  `EntityConnection`).
- **ADO → Plane only.** Plane → ADO and full comment sync are out of scope; the
  `entity_comment_syncs` structure and `external_source` tagging lay the groundwork.
- **PAT auth**, not the OAuth App-installation flow GitHub uses.
- **Assignee mapping is best-effort** (email → Plane member, via `USER_MAP_JSON`);
  unmapped users are left unassigned. `import: "invite"` is reserved for later.
- Labels are managed to match ADO tags + the default label, so manually-added
  Plane labels may be overwritten on sync.
- **Test plans / test suites** (ADO test-management entities) are not synced —
  only Test **Case** work items are. ADO emits work item webhooks, not test-plan
  webhooks, so plan/suite sync would need the Test API + polling.
- **Sprint dates** aren't pulled — cycles are created by name. **Parent links**
  apply once the parent has itself been synced.
