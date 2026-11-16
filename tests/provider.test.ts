import assert from "node:assert/strict";
import { test } from "node:test";
import { modelClassifier } from "../src/provider";
import { ClassificationError } from "../src/worker";

const config = { endpoint: "https://provider.test/classify", key: "test-key", model: "test-model" };
const event = { id: "model-test", type: "support.requested" as const, subject: "Invoice", body: "Please check the total." };

test("accepts only the validated model classification and sends data as a separate message", async () => {
  const classifier = modelClassifier(config, async (url, init) => {
    assert.equal(url, config.endpoint);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].role, "user");
    assert.equal(JSON.parse(body.messages[1].content).subject, event.subject);
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      category: "billing", priority: "low", rationale: "Routine invoice question."
    }) } }] });
  });
  assert.equal((await classifier(event, 1)).priority, "low");
});

test("classifies provider failures by retryability and rejects malformed output", async () => {
  const cases = [
    [new Response(null, { status: 429 }), "provider_rate_limit", true],
    [new Response(null, { status: 503 }), "provider_unavailable", true],
    [new Response(null, { status: 401 }), "provider_rejected", false],
    [Response.json({ choices: [{ message: { content: '{"category":"something else"}' } }] }), "provider_invalid_response", false]
  ] as const;
  for (const [response, code, transient] of cases) {
    await assert.rejects(modelClassifier(config, async () => response)(event, 1),
      error => error instanceof ClassificationError && error.code === code && error.transient === transient);
  }
});
