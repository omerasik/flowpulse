import type { Classification, SupportEvent } from "./domain";
import type { RunStore } from "./store";

export type Classifier = (event: SupportEvent, attempt: number) => Promise<Classification>;

export class ClassificationError extends Error {
  constructor(public readonly code: string, public readonly transient: boolean) {
    super(code);
  }
}

export const classifyWithRules: Classifier = async ({ subject, body }) => {
  const text = subject + " " + body;
  const urgent = /\b(outage|down|locked out|urgent|unavailable)\b/i.test(text);
  const category = /\b(invoice|payment|refund|charge|billing)\b/i.test(text) ? "billing"
    : /\b(account|login|password|locked out)\b/i.test(text) ? "account"
    : /\b(error|broken|outage|down|crash|unavailable)\b/i.test(text) ? "technical" : "general";
  return {
    category,
    priority: urgent ? "high" : "normal",
    rationale: urgent ? "Urgency language detected in the support request." : "Routed using the support category rules."
  };
};

export async function processNext(store: RunStore, classify: Classifier, clock = () => new Date()) {
  const job = await store.claim(clock());
  if (!job) return { status: "idle" as const };
  let result: Classification;
  try {
    result = await classify(job.payload, job.attempts);
  } catch (error) {
    const failure = error instanceof ClassificationError ? error : new ClassificationError("classifier_error", false);
    const status = await store.fail(job, failure.code, failure.transient, clock());
    return { id: job.id, status };
  }
  const draft = [
    "Support request: " + job.payload.subject,
    "Route to: " + result.category + " support",
    "Priority: " + result.priority,
    "Reason: " + result.rationale,
    "",
    "Next action: review the request and assign a support owner."
  ].join("\n");
  const saved = await store.draft(job, result, draft, clock());
  return { id: job.id, status: saved ? "awaiting_approval" as const : "stale" as const };
}
