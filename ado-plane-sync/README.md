# ado-plane-sync

An external sync service that ingests **Azure DevOps** Service Hook webhooks
(`workitem.created` / `workitem.updated`) and syncs each work item into **Plane**
as a work item (issue). It runs alongside Plane and talks to Plane's public REST
API — **Plane itself is not modified**.

It is deliberately built to feel native to Plane, following the conventions
shared by Plane's own **GitHub** integration and **Jira** importer.

---

## How it mirrors Plane's integrations

| Plane convention (real) | Where it lives in Plane | What this service does |
| --- | --- | --- |
| `external_id` + `external_source` as the idempotent link on every entity | `apps/api/.../db/models/issue.py`, label/state; create returns **409 + existing id** on duplicate | Every synced issue/label is written with `external_source="azure_devops"`, `external_id="<ado id>"` |
| Layered sync model `Integration → WorkspaceIntegration → *Repository/Project → *IssueSync → *CommentSync` | `db/models/integration/github.py` | `integrations → workspace_integrations → ado_projects → ado_project_syncs → ado_work_item_syncs → ado_comment_syncs` |
| Importer connection shape `{ service, status, config, metadata, data }` with `data.users` user mapping | `packages/types/src/importer` (`IImporterService`, jira/github importers) | `ado_project_syncs` stores `service`, `status`, `config` (`{sync, state_map}`), `metadata` (`{organization, project, url}`), `data` (`{users}`) |
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
ADO Service Hook ──HTTP──▶ POST /webhooks/azure-devops
                              │  (auth: Basic or X-Webhook-Secret)
                              ▼
                          parse envelope ──▶ enqueue sync_jobs ──▶ 202 Accepted
                                                     │
                              worker (poll, retry)   ▼
                          fetch full work item from ADO REST
                                                     │
                              map fields → resolve state/labels/assignee
                                                     │
                          upsert Plane issue (external_id/external_source)
                                                     │
                              record ado_work_item_syncs (+ optional ADO backlink)
```

Source layout (`src/`): `config`, `logger`, `types`, `db` (schema + stores),
`queue`, `connection` (bootstrap), `parsers/azureDevOpsWebhook`,
`mappers/{stateMapper,userMapper,workItemMapper}`, `clients/{azureDevOps,plane}`,
`sync/workItemSync`, `routes/azureWebhook`, `worker`, `server`, `index`.

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
| `STATE_MAP_JSON` | no | `{"New":"Backlog","Active":"In Progress","Resolved":"Done","Closed":"Done"}` | ADO state name → Plane state name |
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
unsupported event types, `400` for malformed payloads, and `401` when the secret
is missing/invalid.

---

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe |
| `POST` | `/webhooks/azure-devops` | Receives ADO Service Hook events |

---

## Data model

`ensureSchema()` creates these tables on boot (idempotent):

- `integrations`, `workspace_integrations` — the provider + workspace install
- `ado_projects`, `ado_project_syncs` — the connected external project ↔ Plane project
- `ado_work_item_syncs` — work item ↔ Plane issue mapping (`last_ado_rev` drives idempotency)
- `ado_comment_syncs` — backlink/comment mapping
- `sync_jobs` — the durable webhook queue

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
  `ado_comment_syncs` structure and `external_source` tagging lay the groundwork.
- **PAT auth**, not the OAuth App-installation flow GitHub uses.
- **Assignee mapping is best-effort** (email → Plane member, via `USER_MAP_JSON`);
  unmapped users are left unassigned. `import: "invite"` is reserved for later.
- Labels are managed to match ADO tags + the default label, so manually-added
  Plane labels may be overwritten on sync.
