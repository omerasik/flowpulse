import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createApi } from "../src/api";
import { signWebhook } from "../src/auth";
import { openDatabase } from "../src/database";
import type { Database } from "../src/database";
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
