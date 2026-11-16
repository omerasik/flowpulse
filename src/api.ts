import { randomUUID } from "node:crypto";
import { z } from "zod";
import { matches, verifyWebhook } from "./auth";
import { AppError, supportEvent } from "./domain";
import type { Settings } from "./settings";
import type { RunStore } from "./store";
import { processNext } from "./worker";

const decisionSchema = z.object({ decision: z.enum(["approve", "reject"]) }).strict();

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBytes(request: Request, limit = 16 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) {
    throw new AppError(415, "expected_json");
  }
  if (Number(request.headers.get("Content-Length")) > limit) throw new AppError(413, "body_too_large");
  if (!request.body) throw new AppError(400, "invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, total);
      total += chunk.value.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(413, "body_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AppError(400, "invalid_json");
  }
}

function requireToken(request: Request, token: string) {
  if (!matches(request.headers.get("Authorization"), "Bearer " + token)) throw new AppError(401, "unauthorized");
}

type Dependencies = {
  store: () => Promise<RunStore>;
  settings: () => Settings;
  clock?: () => Date;
};

export function createApi({ store, settings, clock = () => new Date() }: Dependencies) {
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    const { method } = request;
    try {
      if (method === "GET" && path === "/api/health") return json({ status: "ok" });
      const config = settings();

      if (method === "POST" && path === "/api/events") {
        const bytes = await readBytes(request);
        const now = clock();
        verifyWebhook(request.headers, config.webhookSecret, bytes, now);
        const event = supportEvent.safeParse(parseJson(bytes));
        if (!event.success) throw new AppError(422, "invalid_support_event");
        const result = await (await store()).enqueue(event.data, now);
        return json(result, result.duplicate ? 200 : 202);
      }

      if (method === "POST" && path === "/api/worker/tick") {
        requireToken(request, config.workerToken);
        return json(await processNext(await store(), config.classify, clock));
      }

      if (method === "GET" && path === "/api/runs") {
        requireToken(request, config.operatorToken);
        return json({ runs: await (await store()).list(), demo: config.demo, provider: config.provider });
      }

      const runPath = /^\/api\/runs\/([^/]+)(\/decision)?$/.exec(path);
      if (runPath && ((method === "GET" && !runPath[2]) || (method === "POST" && runPath[2]))) {
        requireToken(request, config.operatorToken);
        const id = z.uuid().safeParse(runPath[1]);
        if (!id.success) throw new AppError(404, "run_not_found");
        if (method === "GET") return json(await (await store()).get(id.data));
        const decision = decisionSchema.safeParse(parseJson(await readBytes(request, 384)));
        if (!decision.success) throw new AppError(422, "invalid_decision");
        return json(await (await store()).decide(id.data, decision.data.decision, clock()));
      }

      if (config.demo && method === "POST" && path === "/api/demo/sample") {
        requireToken(request, config.operatorToken);
        const event = {
          id: "demo-retry-" + randomUUID(),
          type: "support.requested" as const,
          subject: "Billing portal outage after payment",
          body: "The billing portal is unavailable after a payment. Please route this request for urgent review."
        };
        return json(await (await store()).enqueue(event, clock()), 202);
      }

      if (config.demo && method === "POST" && path === "/api/demo/tick") {
        requireToken(request, config.operatorToken);
        return json(await processNext(await store(), config.classify, clock));
      }

      throw new AppError(404, "route_not_found");
    } catch (error) {
      if (error instanceof AppError) return json({ error: error.code }, error.status);
      console.error(JSON.stringify({ event: "api_error", method, kind: "internal" }));
      return json({ error: "internal_error" }, 500);
    }
  };
}
