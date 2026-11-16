import { schedules } from "@trigger.dev/sdk";
import { z } from "zod";

const tickResponse = z.object({ status: z.enum(["idle", "retrying", "failed", "awaiting_approval", "stale"]), id: z.uuid().optional() });

export const drainSupportQueue = schedules.task({
  id: "drain-support-queue",
  cron: "0 * * * *",
  queue: { concurrencyLimit: 1 },
  run: async () => {
    const target = process.env.FLOWPULSE_URL;
    const token = process.env.WORKER_TOKEN;
    if (!target || !token) throw new Error("Set FLOWPULSE_URL and WORKER_TOKEN in Trigger.dev.");
    const endpoint = new URL("/api/worker/tick", target);
    if (endpoint.protocol !== "https:") throw new Error("FlowPulse scheduler URL must use HTTPS.");

    let processed = 0;
    for (; processed < 20; processed += 1) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        redirect: "error",
        signal: AbortSignal.timeout(13_000)
      });
      if (!response.ok) throw new Error("FlowPulse worker HTTP " + response.status);
      const tick = tickResponse.parse(await response.json());
      if (tick.status === "idle") break;
    }
    return { processed };
  }
});
