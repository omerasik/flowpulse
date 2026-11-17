# FlowPulse

FlowPulse turns signed support events into tracked work. A background worker classifies each request and prepares a notification draft. An operator can approve delivery to a configured destination, retry failed steps, and inspect the run history.

![Run dashboard showing an approval draft and its retry history](docs/dashboard.png)

## Run locally

Use Node.js 22.14+ and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

On PowerShell, use `Copy-Item .env.example .env`. Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Select **Run sample** to create a synthetic event and see one deliberately failed classification attempt. After the retry, inspect the draft and select **Approve delivery**, then **Process next**. The execution trace shows the persisted local inbox receipt. **Reject** ends the run at the review stage.

To exercise the real webhook signature and verify the same retry path with HTTP, leave the server running and use a second terminal.

```sh
npm run demo
```

The script prints the resulting run and leaves it in the approval queue. Pass `npm run demo -- --approve` to approve the synthetic event and verify its local completion from the terminal. Run `npm run worker` to poll for new work every two seconds, or use **Process next** to claim one eligible step in the dashboard.

## Architecture

Next.js and React serve the dashboard and REST API. The queue and approval state live in PostgreSQL. PGlite uses the same schema and queries for the local single-process setup. Zod validates webhook and model payloads. Trigger.dev can run the worker on an hourly schedule. [Architecture and state transitions](docs/architecture.md).

## HTTP API

| Method and path | Authorization | Result |
| --- | --- | --- |
| GET `/api/health` | Public | Application liveness |
| POST `/api/events` | Timestamped HMAC | 202 with a new run ID, or 200 for a matching replay |
| GET `/api/runs` | Operator bearer token | Latest 100 runs, persisted worker activity, provider label and delivery destination |
| GET `/api/runs/{id}` | Operator bearer token | Run status, draft and trace |
| POST `/api/runs/{id}/decision` | Operator bearer token | Approve or reject a draft. Approval includes the displayed `target` when configured. |
| POST `/api/runs/{id}/operation` | Operator bearer token | Retry a failed step with `{"operation":"retry"}` or stop pending work with `{"operation":"cancel"}` |
| POST `/api/worker/tick` | Worker bearer token | Processes one eligible run or returns `idle` |

A signed event body has four fields.

```json
{
  "id": "support-123",
  "type": "support.requested",
  "subject": "Billing portal outage",
  "body": "The payment dashboard is unavailable."
}
```

Send it as `application/json` with `X-FlowPulse-Timestamp` set to Unix time in seconds. Set `X-FlowPulse-Signature` to `sha256=` followed by the hex HMAC-SHA256 of the timestamp, a period and the original UTF-8 request bytes. A webhook body is limited to 16 KiB. A replay with a conflicting payload returns 409. [Executable webhook example](scripts/demo.mjs).

## Configuration

| Variable | Purpose |
| --- | --- |
| `DEMO_MODE` | Enables the sample and loopback demo credentials. Set to `false` on a deployed app. |
| `OPERATOR_TOKEN`, `WORKER_TOKEN`, `WEBHOOK_SECRET` | Distinct random credentials at least 32 characters long when demo mode is off. |
| `WEBHOOK_REQUESTS_PER_MINUTE` | Shared per-minute quota for authenticated, valid webhook submissions. Defaults to 120 and returns HTTP 429 with `Retry-After` when exhausted. |
| `DATABASE_URL` | External PostgreSQL connection URL. |
| `DATABASE_PATH` | Embedded PostgreSQL path when `DATABASE_URL` is unset. Defaults to `data/flowpulse`. |
| `AI_PROVIDER` | Defaults to `rules` and makes zero model calls. `openai` opts in to a compatible Chat Completions endpoint. |
| `AI_ENDPOINT`, `AI_MODEL`, `AI_API_KEY` | HTTPS Chat Completions endpoint, model supporting strict JSON Schema output, and API secret. The provider receives the subject and message. |
| `AI_INPUT_USD_PER_MILLION`, `AI_OUTPUT_USD_PER_MILLION` | Optional USD prices per million input and output tokens. Set both to enable cost estimates. |
| `ACTION_CONNECTOR` | `none` records approval without dispatch, `local` writes to the demo database inbox, and `webhook` delivers to an authorized HTTPS receiver. |
| `ACTION_WEBHOOK_URL`, `ACTION_WEBHOOK_TOKEN` | Exact HTTPS destination and a bearer credential of at least 32 characters for webhook delivery. |
| `FLOWPULSE_URL` | Base app URL for the worker, demo script and hosted scheduler. |
| `TRIGGER_PROJECT_REF` | Trigger.dev project reference for task deployment. |

To use Docker Compose, copy the env example and add a URL-safe random `FLOWPULSE_DB_PASSWORD`. Run `docker compose up --build`. The service binds to loopback and uses a persistent PostgreSQL volume. Run the local poller separately or configure the scheduler.

For Trigger.dev, deploy the app behind HTTPS and set `WORKER_TOKEN` and `FLOWPULSE_URL` in the Trigger.dev environment. Set `TRIGGER_PROJECT_REF` for the CLI and deploy the task with `npx trigger.dev@4.8.5 deploy`. The hourly job claims up to 20 eligible runs and uses the same worker endpoint as the local poller. The hosted schedule and the paid model path require user-provided accounts and credentials.

Model classifications include priority, rationale, a suggested team and a proposed next action for operator review. The dashboard supports subject and event ID search and shows the model, latency, token counts and cost estimate where available. Recent cost totals cover successful, priced classifications from the latest 100 runs. Each estimate applies the configured token rates.

Worker activity reports the last completed poll and cumulative outcomes for the worker endpoint and manual demo. The quota and worker counters persist across app processes using the same PostgreSQL database.

### Notification receiver

The webhook connector posts `{"runId":"…","message":"…"}` with the configured bearer token. A receiver must store or deduplicate the run's `Idempotency-Key` before acknowledging it. A 2xx response completes the delivery. Network failures, 408, 429 and 5xx trigger bounded retries with the same key. Use an authorized receiver that supports this contract. If a destination configuration changes after approval, the run fails before sending. Restoring that destination allows an operator to retry the same approved step.

## Verification

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm audit --audit-level=moderate
```

Tests use an isolated in-memory PostgreSQL instance by default. For the server-mode tests, set `TEST_DATABASE_URL` to a dedicated disposable PostgreSQL database. The test suite clears its `runs` table between cases. GitHub Actions runs the same suite against PostgreSQL 17.

## Scope and original work

FlowPulse supports one event type, a built-in workflow, one shared operator role and a 100-run dashboard snapshot. The HTTPS adapter is covered by protocol tests and needs an authorized receiver for live verification. The paid model and hosted scheduler need separate account configuration. Deploy with TLS, a dedicated database and rate limits at the ingress. The local demo runs without a container daemon or external account.

Original work includes raw-body webhook verification, replay-safe ingestion, expiring PostgreSQL worker leases, per-step retries, strict model outputs with usage tracking, and approval-bound delivery with a local inbox. The Trigger.dev examples informed the scheduler integration. [Third-party notices](THIRD_PARTY_NOTICES.md) · [MIT license](LICENSE).
