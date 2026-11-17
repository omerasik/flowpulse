import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.FLOWPULSE_URL ?? "http://127.0.0.1:3000";
const operator = process.env.OPERATOR_TOKEN ?? "flowpulse-local-demo";
const worker = process.env.WORKER_TOKEN ?? "flowpulse-local-worker";
const secret = process.env.WEBHOOK_SECRET ?? "flowpulse-local-webhook";
const background = process.argv.includes("--background");

async function call(path, { token, headers, ...options } = {}) {
  const response = await fetch(new URL("/api/" + path, base), {
    ...options,
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(20_000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(response.status + " " + (result.error ?? "request_failed"));
  return result;
}

try {
  const location = new URL(base);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) {
    throw new Error("The synthetic demo expects a local server.");
  }
  const body = JSON.stringify({
    id: "demo-retry-" + randomUUID(),
    type: "support.requested",
    subject: "Duplicate payment on April invoice",
    body: "The billing portal shows two charges for one invoice. Please confirm the payment."
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = "sha256=" + createHmac("sha256", secret).update(timestamp + "." + body).digest("hex");
  const event = await call("events", {
    method: "POST", body, headers: {
      "Content-Type": "application/json", "X-FlowPulse-Timestamp": timestamp, "X-FlowPulse-Signature": signature
    }
  });
  let run;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!background) await call("worker/tick", { method: "POST", token: worker });
    run = await call("runs/" + event.id, { token: operator });
    if (run.status === "awaiting_approval") break;
    if (run.status === "failed") throw new Error(run.error_code ?? "workflow_failed");
    await delay(550);
  }
  if (run?.status !== "awaiting_approval") throw new Error("Timed out waiting for the draft.");
  if (process.argv.includes("--approve")) {
    const { actionTarget } = await call("runs", { token: operator });
    if (actionTarget && actionTarget !== "Local delivery inbox") {
      const receiver = new URL(actionTarget);
      if (!process.argv.includes("--approve-local-receiver") || receiver.protocol !== "http:" ||
        !["127.0.0.1", "[::1]"].includes(receiver.hostname)) {
        throw new Error("Use the operator dashboard to approve an external delivery.");
      }
    }
    run = await call("runs/" + event.id + "/decision", {
      method: "POST", token: operator, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve", target: actionTarget })
    });
    for (let attempt = 0; run.status !== "completed" && attempt < 60; attempt += 1) {
      if (!background) await call("worker/tick", { method: "POST", token: worker });
      run = await call("runs/" + event.id, { token: operator });
      if (run.status === "failed") throw new Error(run.error_code ?? "delivery_failed");
      if (run.status !== "completed") await delay(550);
    }
    if (run.status !== "completed") throw new Error("Timed out waiting for delivery.");
  }
  console.log(JSON.stringify({ url: base, run }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Demo failed.");
  process.exitCode = 1;
}
