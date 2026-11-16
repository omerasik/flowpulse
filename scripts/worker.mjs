import { setTimeout as delay } from "node:timers/promises";

const target = new URL("/api/worker/tick", process.env.FLOWPULSE_URL ?? "http://127.0.0.1:3000");
const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
const token = process.env.WORKER_TOKEN || (process.env.DEMO_MODE === "true" && loopback ? "flowpulse-local-worker" : "");
if (!token || (!loopback && target.protocol !== "https:")) {
  throw new Error("Configure WORKER_TOKEN and use HTTPS for remote workers.");
}
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
while (!stop.signal.aborted) {
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]),
      redirect: "error"
    });
    const result = await response.json();
    if (!response.ok) throw new Error("worker_http_" + response.status);
    if (result.status !== "idle") console.log(JSON.stringify({ event: "worker_tick", ...result }));
  } catch {
    if (!stop.signal.aborted) console.error(JSON.stringify({ event: "worker_tick_failed" }));
  }
  await delay(2000, undefined, { signal: stop.signal }).catch(() => undefined);
}
