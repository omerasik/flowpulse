import type { Classification, ClassifierTelemetry, SupportEvent, WorkerOutcome } from "./domain";
import { DeliveryError } from "./connector";
import type { NotificationConnector } from "./connector";
import type { RunStore } from "./store";

export type ClassificationResult = Classification & { telemetry?: ClassifierTelemetry };
export type Classifier = (event: SupportEvent, attempt: number) => Promise<ClassificationResult>;

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
    rationale: urgent ? "Urgency language detected in the support request." : "Routed using the support category rules.",
    team: `${category} support`,
    nextAction: "Review the request and assign a support owner."
  };
};

export async function processNext(
  store: RunStore, classify: Classifier, clock = () => new Date(), connector?: NotificationConnector
): Promise<{ status: "idle" } | { id: string; status: Exclude<WorkerOutcome, "idle"> }> {
  const job = await store.claim(clock());
  if (!job) return { status: "idle" as const };
  if (job.stage === "deliver") {
    if (!connector || job.action_target !== connector.target || !job.draft) {
      return { id: job.id, status: await store.fail(job, "delivery_configuration_changed", false, clock()) };
    }
    try {
      await connector.send({ id: job.id, draft: job.draft });
    } catch (error) {
      const failure = error instanceof DeliveryError ? error : new DeliveryError("delivery_error", true);
      return { id: job.id, status: await store.fail(job, failure.code, failure.transient, clock()) };
    }
    const delivered = await store.finishDelivery(job, clock());
    return { id: job.id, status: delivered ? "completed" as const : "stale" as const };
  }
  let result: ClassificationResult;
  try {
    result = await classify(job.payload, job.attempts);
  } catch (error) {
    const failure = error instanceof ClassificationError ? error : new ClassificationError("classifier_error", false);
    const status = await store.fail(job, failure.code, failure.transient, clock());
    return { id: job.id, status };
  }
  const { telemetry, ...classification } = result;
  const draft = [
    "Support request: " + job.payload.subject,
    "Route to: " + (result.team ?? `${result.category} support`),
    "Priority: " + result.priority,
    "Reason: " + result.rationale,
    "",
    "Next action: " + (result.nextAction ?? "Review the request and assign a support owner.")
  ].join("\n");
  const saved = await store.draft(job, classification, draft, clock(), telemetry);
  return { id: job.id, status: saved ? "awaiting_approval" as const : "stale" as const };
}
