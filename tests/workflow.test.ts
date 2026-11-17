import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createApi } from "../src/api";
import { signWebhook } from "../src/auth";
import { openDatabase } from "../src/database";
import type { Database } from "../src/database";
import { DeliveryError, webhookConnector } from "../src/connector";
import { leaseMs, maxAttempts } from "../src/domain";
import type { Run } from "../src/domain";
import { readSettings } from "../src/settings";
import { RunStore } from "../src/store";
import { ClassificationError, classifyWithRules, processNext } from "../src/worker";

let database: Database;
let store: RunStore;
let milliseconds: number;
const env = {
  OPERATOR_TOKEN: "operator".repeat(5),
  WORKER_TOKEN: "worker".repeat(6),
  WEBHOOK_SECRET: "webhook".repeat(5)
};
const settings = readSettings(env);
const clock = () => new Date(milliseconds);
const api = createApi({
  store: async () => store,
  settings: () => ({
    ...settings,
    classify: async (event, attempt) => {
      if (event.id === "retry" && attempt === 1) throw new ClassificationError("provider_rate_limit", true);
      return classifyWithRules(event, attempt);
    }
  }),
  clock
});

const event = (id = "support-1") => ({
  id, type: "support.requested" as const, subject: "Invoice portal outage", body: "The payment dashboard is unavailable."
});
const auth = (token: string) => ({ Authorization: "Bearer " + token });
const request = (path: string, init?: RequestInit) => api(new Request("http://localhost/api/" + path, init));
const webhook = (body: string, at = Math.floor(milliseconds / 1000).toString(), signature?: string) => request("events", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-FlowPulse-Timestamp": at,
    "X-FlowPulse-Signature": signature ?? signWebhook(settings.webhookSecret, at, Buffer.from(body))
  },
  body
});
const run = async (id: string): Promise<Run> => {
  const response = await request("runs/" + id, { headers: auth(settings.operatorToken) });
  assert.equal(response.status, 200);
  return response.json();
};
const tick = () => request("worker/tick", { method: "POST", headers: auth(settings.workerToken) });
const decision = (id: string, value: string) => request("runs/" + id + "/decision", {
  method: "POST", headers: { ...auth(settings.operatorToken), "Content-Type": "application/json" },
  body: JSON.stringify({ decision: value })
});

before(async () => {
  database = await openDatabase({ url: process.env.TEST_DATABASE_URL });
  store = new RunStore(database);
});
beforeEach(async () => {
  milliseconds = Date.parse("2026-11-16T10:00:00Z");
  await database.query("DELETE FROM runs");
  await database.query("DELETE FROM worker_activity");
  await database.query("DELETE FROM webhook_quota");
});
after(async () => database?.close());

test("validates webhook bytes, time, structure and request size before enqueue", async () => {
  const body = JSON.stringify(event());
  const at = Math.floor(milliseconds / 1000).toString();
  const supplied = signWebhook(settings.webhookSecret, at, Buffer.from(body));
  assert.equal((await webhook(body + " ", at, supplied)).status, 401);
  assert.equal((await webhook(body, String(Number(at) - 301))).status, 401);
  assert.equal((await webhook("{")).status, 400);
  assert.equal((await webhook(JSON.stringify({ ...event(), body: "" }))).status, 422);
  assert.equal((await webhook(JSON.stringify({ ...event(), body: "x".repeat(17 * 1024) }))).status, 413);
  assert.equal((await request("events", { method: "POST", body: "text" })).status, 415);
  assert.deepEqual(await store.list(), []);
});

test("replays one event idempotently and rejects a changed payload for that ID", async () => {
  const body = JSON.stringify(event());
  const results = await Promise.all([webhook(body), webhook(body), webhook(body)]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 200, 202]);
  const receipts = await Promise.all(results.map(response => response.json()));
  assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 1);
  assert.equal((await webhook(JSON.stringify({ ...event(), subject: "Changed subject" }))).status, 409);
  assert.equal((await store.list()).length, 1);
});

test("coordinates the signed webhook quota across concurrent requests and resets next minute", async () => {
  const limited = createApi({ store: async () => store, clock, settings: () => ({ ...settings, webhookRequests: 2 }) });
  const post = (id: string, signed = true) => {
    const body = JSON.stringify(event(id));
    const timestamp = Math.floor(milliseconds / 1000).toString();
    return limited(new Request("http://localhost/api/events", {
      method: "POST", body, headers: { "Content-Type": "application/json", "X-FlowPulse-Timestamp": timestamp,
        "X-FlowPulse-Signature": signWebhook(signed ? settings.webhookSecret : "invalid", timestamp, Buffer.from(body)) }
    }));
  };
  assert.equal((await post("invalid-one", false)).status, 401);
  const results = await Promise.all([post("quota-a"), post("quota-b"), post("quota-c")]);
  assert.deepEqual(results.map(result => result.status).sort(), [202, 202, 429]);
  assert.equal(results.find(result => result.status === 429)?.headers.get("retry-after"), "60");
  assert.equal((await store.list()).length, 2);
  milliseconds += 60_000;
  assert.equal((await post("quota-next-minute")).status, 202);
});

test("reports persisted worker activity for idle, retried and finished steps", async () => {
  await tick();
  await webhook(JSON.stringify(event("retry")));
  await tick();
  milliseconds += 2_000;
  await tick();
  const response = await request("runs", { headers: auth(settings.operatorToken) });
  const { activity } = await response.json();
  assert.deepEqual(activity, [{
    source: "worker", last_tick_at: clock().toISOString(), last_work_at: clock().toISOString(),
    ticks: 3, idle_ticks: 1, finished_steps: 1, retrying_steps: 1, failed_steps: 0
  }]);
});

test("retries a transient provider error and records an approval once", async () => {
  const receipt = await webhook(JSON.stringify(event("retry")));
  const { id } = await receipt.json();
  assert.equal(receipt.status, 202);
  assert.equal((await decision(id, "approve")).status, 409);
  assert.equal((await (await tick()).json()).status, "retrying");
  assert.equal((await run(id)).error_code, "provider_rate_limit");
  assert.equal((await (await tick()).json()).status, "idle");
  milliseconds += 2_000;
  assert.equal((await (await tick()).json()).status, "awaiting_approval");
  const awaiting = await run(id);
  assert.equal(awaiting.classification?.category, "billing");
  assert.equal(awaiting.classification?.priority, "high");
  assert.match(awaiting.draft ?? "", /Route to: billing support/);
  assert.equal((await decision(id, "ship")).status, 422);
  const approvals = await Promise.all([decision(id, "approve"), decision(id, "approve")]);
  assert.ok(approvals.every(response => response.status === 200));
  assert.equal((await decision(id, "reject")).status, 409);
  const final = await run(id);
  assert.equal(final.status, "completed");
  assert.equal(final.attempts, 2);
  assert.deepEqual(final.trace.map(entry => entry.step),
    ["accepted", "claimed", "retry_scheduled", "claimed", "draft_ready", "approved"]);
});

test("persists proposed routing and model telemetry through the worker and operator API", async () => {
  const { id } = await store.enqueue(event("model"), clock());
  const telemetry = { provider: "openai" as const, model: "test-model", latencyMs: 12, inputTokens: 120, outputTokens: 14 };
  await processNext(store, async () => ({
    category: "billing", priority: "high", rationale: "Payment portal unavailable.",
    team: "technical support", nextAction: "Check portal availability.", telemetry
  }), clock);
  const result = await run(id);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.classification?.team, "technical support");
  assert.deepEqual(result.classifier_telemetry, telemetry);
  assert.match(result.draft ?? "", /Route to: technical support/);
  assert.match(result.draft ?? "", /Check portal availability/);
});

test("queues approved delivery once, recovers a lost acknowledgement and records one receipt", async () => {
  const demoSettings = readSettings({ DEMO_MODE: "true", ACTION_CONNECTOR: "local" });
  const local = demoSettings.connectorFor?.(store);
  assert.ok(local);
  let count = 0;
  const connector = { ...local, async send(notice: Parameters<typeof local.send>[0]) {
    await local.send(notice);
    if (++count === 1) throw new DeliveryError("delivery_unreachable", true);
  } };
  const deliveryApi = createApi({ store: async () => store, clock, settings: () => ({
    ...settings, actionTarget: connector.target, connectorFor: () => connector
  }) });
  const receipt = await webhook(JSON.stringify(event("approval-delivery")));
  const { id } = await receipt.json();
  const call = (path: string, token: string, body?: object) => deliveryApi(new Request("http://localhost/api/" + path, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  }));
  const deliveryTick = () => call("worker/tick", settings.workerToken);
  const approve = (target: string) => call("runs/" + id + "/decision", settings.operatorToken, { decision: "approve", target });
  assert.equal((await (await deliveryTick()).json()).status, "awaiting_approval");
  assert.equal((await (await deliveryTick()).json()).status, "idle");
  assert.equal(count, 0);
  assert.equal((await approve("A different destination")).status, 409);
  const decisions = await Promise.all([approve(connector.target), approve(connector.target)]);
  assert.ok(decisions.every(response => response.status === 200));
  assert.equal((await (await deliveryTick()).json()).status, "retrying");
  milliseconds += 2_000;
  const results = await Promise.all([deliveryTick(), deliveryTick()]);
  const states = await Promise.all(results.map(async response => (await response.json()).status));
  assert.deepEqual(states.sort(), ["completed", "idle"]);
  assert.equal(count, 2);
  const deliveries = await database.query("SELECT run_id FROM local_deliveries WHERE run_id = $1", [id]);
  assert.equal(deliveries.length, 1);
  assert.deepEqual((await run(id)).trace.map(item => item.step), [
    "accepted", "claimed", "draft_ready", "approved", "delivery_claimed",
    "delivery_retry_scheduled", "delivery_claimed", "delivered"
  ]);
  assert.equal((await approve(connector.target)).status, 200);
});

test("can requeue a failed step and cancel pending work without losing the audit trail", async () => {
  const { id } = await store.enqueue(event("operator-control"), clock());
  await processNext(store, async () => { throw new ClassificationError("provider_rejected", false); }, clock);
  const operate = (operation: string, token = settings.operatorToken) => request("runs/" + id + "/operation", {
    method: "POST", headers: { ...auth(token), "Content-Type": "application/json" }, body: JSON.stringify({ operation })
  });
  assert.equal((await operate("retry", settings.workerToken)).status, 401);
  assert.equal((await operate("retry")).status, 200);
  assert.equal((await operate("retry")).status, 409);
  assert.equal((await operate("cancel")).status, 200);
  assert.equal((await operate("cancel")).status, 200);
  assert.equal((await (await tick()).json()).status, "idle");
  assert.deepEqual((await run(id)).trace.map(item => item.step), ["accepted", "claimed", "classification_failed", "manual_retry", "cancelled"]);
});

test("uses the configured destination and run-scoped key for webhook delivery", async () => {
  const endpoint = "https://notifications.example.test/inbound";
  const notice = { id: "stable-run-id", draft: "Approved notification" };
  const connector = webhookConnector(endpoint, "local-test-token", async (url, options) => {
    assert.equal(url, endpoint);
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("authorization"), "Bearer local-test-token");
    assert.equal(headers.get("idempotency-key"), notice.id);
    assert.deepEqual(JSON.parse(String(options?.body)), { runId: notice.id, message: notice.draft });
    return new Response(null, { status: 204 });
  });
  await connector.send(notice);
});

test("requires role-specific tokens and disables demo routes in deploy mode", async () => {
  assert.equal((await request("health")).status, 200);
  assert.equal((await request("runs")).status, 401);
  assert.equal((await request("runs", { headers: auth(settings.workerToken) })).status, 401);
  assert.equal((await request("worker/tick", { method: "POST", headers: auth(settings.operatorToken) })).status, 401);
  assert.equal((await request("demo/sample", { method: "POST", headers: auth(settings.operatorToken) })).status, 404);
  assert.throws(() => readSettings({}), /secrets/);
});

test("only one worker claims a run, a stale lease cannot commit, and rejection persists", async () => {
  const receipt = await store.enqueue(event(), clock());
  const claims = await Promise.all([store.claim(clock()), store.claim(clock())]);
  assert.equal(claims.filter(Boolean).length, 1);
  const old = claims.find(job => job !== undefined);
  assert.ok(old);
  milliseconds += leaseMs;
  const renewed = await store.claim(clock());
  assert.ok(renewed);
  assert.equal(renewed.attempts, 2);
  const output = await classifyWithRules(event(), 1);
  assert.equal(await store.draft(old, output, "Stale result", clock()), false);
  assert.equal(await store.draft(renewed, output, "Current result", clock()), true);
  assert.equal((await decision(receipt.id, "reject")).status, 200);
  const final = await run(receipt.id);
  assert.equal(final.status, "rejected");
  assert.equal(final.draft, "Current result");
  assert.ok(final.trace.some(entry => entry.step === "lease_reclaimed"));
});

test("stops retrying after three failures and expires the final crashed lease", async () => {
  const first = await store.enqueue(event("failing"), clock());
  const fail = async () => { throw new ClassificationError("provider_unavailable", true); };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await processNext(store, fail, clock);
    milliseconds += 10_000;
  }
  assert.equal((await store.get(first.id)).status, "failed");
  assert.equal((await store.get(first.id)).attempts, maxAttempts);

  const second = await store.enqueue(event("crashed"), clock());
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    assert.ok(await store.claim(clock()));
    milliseconds += leaseMs;
  }
  assert.equal(await store.claim(clock()), undefined);
  assert.equal((await store.get(second.id)).error_code, "lease_exhausted");
});

test("creates a fresh nested database path and preserves runs across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowpulse-db-"));
  const path = join(directory, "data", "flowpulse");
  try {
    const first = await openDatabase({ path });
    const run = await new RunStore(first).enqueue(event("persisted"), clock()).finally(() => first.close());
    const reopened = await openDatabase({ path });
    try {
      assert.equal((await new RunStore(reopened).get(run.id)).event_id, "persisted");
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
