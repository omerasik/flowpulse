import assert from "node:assert/strict";
import { test } from "node:test";
import { modelClassifier } from "../src/provider";
import { ClassificationError } from "../src/worker";

const config = { endpoint: "https://provider.test/classify", key: "test-key", model: "test-model",
  pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 } };
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
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.ok(body.response_format.json_schema.schema.required.includes("team"));
    return Response.json({ model: "resolved-model", usage: { prompt_tokens: 500, completion_tokens: 125 },
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        category: "billing", priority: "low", rationale: "Routine invoice question.",
        team: "billing support", nextAction: "Check the invoice total."
      }) } }] });
  });
  const result = await classifier(event, 1);
  assert.equal(result.priority, "low");
  assert.equal(result.team, "billing support");
  assert.equal(result.nextAction, "Check the invoice total.");
  assert.equal(result.telemetry?.model, "resolved-model");
  assert.equal(result.telemetry?.inputTokens, 500);
  assert.equal(result.telemetry?.outputTokens, 125);
  assert.equal(result.telemetry?.estimatedUsd, 0.002);
  assert.ok((result.telemetry?.latencyMs ?? -1) >= 0);
});

test("classifies provider failures by retryability and rejects malformed output", async () => {
  const cases = [
    [new Response(null, { status: 429 }), "provider_rate_limit", true],
    [new Response(null, { status: 503 }), "provider_unavailable", true],
    [new Response(null, { status: 401 }), "provider_rejected", false],
    [new Response(" ".repeat(32 * 1024 + 1)), "provider_invalid_response", false],
    [Response.json({ choices: [{ message: { content: null, refusal: "declined" } }] }), "provider_invalid_response", false],
    [Response.json({ choices: [{ message: { content: '{"category":"something else"}' } }] }), "provider_invalid_response", false]
  ] as const;
  for (const [response, code, transient] of cases) {
    await assert.rejects(modelClassifier(config, async () => response)(event, 1),
      error => error instanceof ClassificationError && error.code === code && error.transient === transient);
  }
});
