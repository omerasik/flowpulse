import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./domain";

export function matches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function signWebhook(secret: string, timestamp: string, body: Uint8Array) {
  return "sha256=" + createHmac("sha256", secret).update(timestamp + ".").update(body).digest("hex");
}

export function verifyWebhook(headers: Headers, secret: string, body: Uint8Array, now: Date) {
  const timestamp = headers.get("x-flowpulse-timestamp");
  if (!timestamp || !/^\d{10}$/.test(timestamp) || Math.abs(now.getTime() - Number(timestamp) * 1000) > 300_000) {
    throw new AppError(401, "invalid_timestamp");
  }
  if (!matches(headers.get("x-flowpulse-signature"), signWebhook(secret, timestamp, body))) {
    throw new AppError(401, "invalid_signature");
  }
}
