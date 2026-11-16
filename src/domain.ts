import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !value.includes("\0"));

export const supportEvent = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/),
  type: z.literal("support.requested"),
  subject: text(160),
  body: text(3000)
}).strict();

export const classification = z.object({
  category: z.enum(["billing", "technical", "account", "general"]),
  priority: z.enum(["low", "normal", "high"]),
  rationale: text(300)
}).strict();

export const routedClassification = classification.extend({
  team: z.enum(["billing support", "technical support", "account support", "general support"]),
  nextAction: text(300)
});

export const statuses = [
  "queued", "running", "retrying", "awaiting_approval", "completed", "rejected", "failed", "cancelled"
] as const;

export type SupportEvent = z.infer<typeof supportEvent>;
export type Classification = z.infer<typeof classification> & Partial<Pick<z.infer<typeof routedClassification>, "team" | "nextAction">>;
export type ClassifierTelemetry = {
  provider: "openai";
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedUsd?: number;
};
export type Status = typeof statuses[number];
export type ReviewDecision = "approve" | "reject";
export type RunOperation = "retry" | "cancel";
export type WorkflowStage = "classify" | "deliver";

export const runMessages = {
  accepted: "Support event queued",
  claimed: "Worker started classification",
  delivery_claimed: "Worker started approved notification delivery",
  retry_scheduled: "Temporary classification failure. Retry scheduled",
  lease_reclaimed: "Worker lease expired. Processing resumed",
  lease_exhausted: "Final worker lease expired",
  classification_failed: "Classification stopped",
  delivery_retry_scheduled: "Temporary delivery failure. Retry scheduled",
  delivery_failed: "Notification delivery stopped",
  delivered: "Notification receiver acknowledged delivery",
  draft_ready: "Classification complete. Draft awaiting review",
  approved: "Operator approved the draft",
  rejected: "Operator rejected the draft",
  cancelled: "Operator cancelled the run",
  manual_retry: "Operator requeued the failed step"
} as const;

export type TraceEntry = { step: keyof typeof runMessages; at: string; attempt: number };
export type Run = {
  id: string;
  event_id: string;
  subject: string;
  status: Status;
  attempts: number;
  classification: Classification | null;
  classifier_telemetry: ClassifierTelemetry | null;
  stage: WorkflowStage;
  action_target: string | null;
  manual_retries: number;
  draft: string | null;
  error_code: string | null;
  trace: TraceEntry[];
  created_at: string;
  updated_at: string;
  available_at: string;
};

export const maxAttempts = 3;
export const leaseMs = 60_000;

export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}
