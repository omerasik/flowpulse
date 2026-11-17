import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const notification = z.object({ runId: z.uuid(), message: z.string().min(1).max(8000) }).strict();

/** @param {{token: string, path?: string, dropFirstAck?: boolean}} options */
export function createReceiver({ token, path = ":memory:", dropFirstAck = false }) {
  if (token.length < 32) throw new Error("Receiver token must contain at least 32 characters");
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, message TEXT NOT NULL, received_at TEXT NOT NULL)");
  let drop = dropFirstAck;
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 8000 }, async (request, response) => {
    const reply = (status, body) => response.writeHead(status, {
      "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"
    }).end(JSON.stringify(body));
    if (request.method === "GET" && request.url === "/health") return reply(200, { status: "ok" });
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from("Bearer " + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: "receiver_auth_required" });
    if (request.method === "GET" && request.url === "/inbox") {
      return reply(200, { receipts: db.prepare("SELECT id, message, received_at FROM receipts ORDER BY received_at DESC LIMIT 100").all() });
    }
    if (request.method !== "POST" || request.url !== "/notify") return reply(404, { error: "route_not_found" });
    try {
      const chunks = [];
      let size = 0;
      for await (const part of request.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.from(part);
        size += bytes.length;
        if (size > 16_384) return reply(413, { error: "notification_too_large" });
        chunks.push(bytes);
      }
      const notice = notification.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!notice.success || request.headers["idempotency-key"] !== notice.data.runId) {
        return reply(422, { error: "invalid_notification" });
      }
      const { runId, message } = notice.data;
      const hash = createHash("sha256").update(message).digest("hex");
      db.prepare("INSERT INTO receipts VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
        .run(runId, hash, message, new Date().toISOString());
      const saved = db.prepare("SELECT hash FROM receipts WHERE id=?").get(runId);
      if (saved?.hash !== hash) return reply(409, { error: "idempotency_conflict" });
      if (drop) { drop = false; request.socket.destroy(); return; }
      return reply(200, { acknowledged: runId });
    } catch (error) {
      const malformed = error instanceof SyntaxError;
      return reply(malformed ? 400 : 503, { error: malformed ? "invalid_notification" : "receiver_unavailable" });
    }
  });
  return { server, async close() {
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    db.close();
  } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.env.DEMO_MODE !== "true") throw new Error("The local receiver requires DEMO_MODE=true");
  const port = Number(process.env.RECEIVER_PORT ?? 3111);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid receiver port");
  const receiver = createReceiver({
    token: process.env.ACTION_WEBHOOK_TOKEN ?? "flowpulse-local-receiver-credential",
    path: process.env.RECEIVER_DATABASE_PATH ?? "data/receiver.sqlite",
    dropFirstAck: process.argv.includes("--drop-first-ack")
  });
  receiver.server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ event: "local_receiver_ready", port })));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void receiver.close(); });
}
