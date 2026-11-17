import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createReceiver } from "../scripts/receiver.mjs";
import { DeliveryError, webhookConnector } from "../src/connector";
import { readSettings } from "../src/settings";

test("real HTTP receiver deduplicates a lost acknowledgement and rejects changed content or credentials", async t => {
  const token = "receiver-integration-credential-only";
  const receiver = createReceiver({ token, dropFirstAck: true });
  await new Promise<void>(resolve => receiver.server.listen(0, "127.0.0.1", resolve));
  t.after(() => receiver.close());
  const origin = "http://127.0.0.1:" + (receiver.server.address() as AddressInfo).port;
  const connector = webhookConnector(origin + "/notify", token);
  const notice = { id: randomUUID(), draft: "Approved local notification" };
  await assert.rejects(connector.send(notice), error => error instanceof DeliveryError && error.transient);
  await connector.send(notice);
  await connector.send(notice);
  const result = await fetch(origin + "/inbox", { headers: { Authorization: "Bearer " + token } });
  const { receipts } = await result.json();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].id, notice.id);
  assert.equal(receipts[0].message, notice.draft);
  await assert.rejects(connector.send({ ...notice, draft: "Changed" }), error =>
    error instanceof DeliveryError && !error.transient && error.code === "delivery_rejected");
  assert.equal((await fetch(origin + "/inbox")).status, 401);
  const env = { DEMO_MODE: "true", ACTION_CONNECTOR: "webhook", ACTION_WEBHOOK_URL: origin + "/notify", ACTION_WEBHOOK_TOKEN: token };
  assert.equal(readSettings(env).actionTarget, origin + "/notify");
  assert.throws(() => readSettings({ ...env, ACTION_WEBHOOK_URL: "http://remote.example.test/notify" }), /notification/);
  assert.throws(() => readSettings({ ...env, DEMO_MODE: "false", OPERATOR_TOKEN: "o".repeat(32),
    WORKER_TOKEN: "w".repeat(32), WEBHOOK_SECRET: "s".repeat(32) }), /notification/);
});
