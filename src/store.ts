import { createHash, randomUUID } from "node:crypto";
import { AppError, leaseMs, maxAttempts } from "./domain";
import type { Classification, ClassifierTelemetry, ReviewDecision, Run, RunOperation, Status, SupportEvent, TraceEntry, WorkflowStage } from "./domain";
import type { Notification } from "./connector";
import type { Database } from "./database";

const fields = `
  id, event_id, subject, status, attempts, classification, classifier_telemetry, draft, error_code, trace,
  stage, action_target, manual_retries,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
  to_char(available_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS available_at
`;

function entry(step: TraceEntry["step"], at: Date, attempt: number) {
  return JSON.stringify([{ step, at: at.toISOString(), attempt }]);
}

export type Job = {
  id: string; status: Status; attempts: number; payload: SupportEvent; lease_token: string;
  stage: WorkflowStage; action_target: string | null; draft: string | null;
};

export class RunStore {
  constructor(private readonly db: Database) {}

  async enqueue(event: SupportEvent, now: Date) {
    const payload = JSON.stringify(event);
    const fingerprint = createHash("sha256").update(payload).digest("hex");
    const [inserted] = await this.db.query<{ id: string }>(`
      INSERT INTO runs (id, event_id, event_hash, payload, subject, status, trace, available_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, 'queued', $6::jsonb, $7, $7, $7)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING id
    `, [randomUUID(), event.id, fingerprint, payload, event.subject, entry("accepted", now, 0), now.toISOString()]);
    if (inserted) return { id: inserted.id, duplicate: false };

    const [existing] = await this.db.query<{ id: string; event_hash: string }>(
      "SELECT id, event_hash FROM runs WHERE event_id = $1", [event.id]
    );
    if (!existing || existing.event_hash !== fingerprint) throw new AppError(409, "event_id_conflict");
    return { id: existing.id, duplicate: true };
  }

  list(): Promise<Run[]> {
    return this.db.query<Run>(`SELECT ${fields} FROM runs ORDER BY runs.created_at DESC, id DESC LIMIT 100`);
  }

  async get(id: string): Promise<Run> {
    const [run] = await this.db.query<Run>(`SELECT ${fields} FROM runs WHERE id = $1`, [id]);
    if (!run) throw new AppError(404, "run_not_found");
    return run;
  }

  async claim(now: Date): Promise<Job | undefined> {
    const at = now.toISOString();
    await this.db.query(`
      UPDATE runs SET status = 'failed', error_code = 'lease_exhausted', lease_until = NULL,
        lease_token = NULL, updated_at = $1::text::timestamptz,
        trace = trace || jsonb_build_array(jsonb_build_object('step', 'lease_exhausted', 'at', $1::text, 'attempt', attempts))
      WHERE id IN (
        SELECT id FROM runs WHERE status = 'running' AND lease_until <= $1::text::timestamptz AND attempts >= $2
        LIMIT 100 FOR UPDATE SKIP LOCKED
      )
    `, [at, maxAttempts]);

    const [job] = await this.db.query<Job>(`
      UPDATE runs SET status = 'running', attempts = attempts + 1, lease_token = $2,
        lease_until = $3, updated_at = $1::text::timestamptz, error_code = NULL,
        trace = trace || jsonb_build_array(jsonb_build_object(
          'step', CASE WHEN status = 'running' THEN 'lease_reclaimed'
                       WHEN stage = 'deliver' THEN 'delivery_claimed' ELSE 'claimed' END,
          'at', $1::text, 'attempt', attempts + 1))
      WHERE id = (
        SELECT id FROM runs WHERE attempts < $4 AND (
          (status IN ('queued', 'retrying') AND available_at <= $1::text::timestamptz)
          OR (status = 'running' AND lease_until <= $1::text::timestamptz)
        )
        ORDER BY available_at, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) RETURNING id, status, attempts, payload, lease_token, stage, action_target, draft
    `, [at, randomUUID(), new Date(now.getTime() + leaseMs).toISOString(), maxAttempts]);
    return job;
  }

  async draft(job: Job, result: Classification, draft: string, now: Date, telemetry?: ClassifierTelemetry) {
    const [saved] = await this.db.query<{ id: string }>(`
      UPDATE runs SET status = 'awaiting_approval', classification = $3::jsonb, draft = $4,
        updated_at = $5, trace = trace || $6::jsonb, lease_token = NULL, lease_until = NULL,
        classifier_telemetry = $7::jsonb
      WHERE id = $1 AND status = 'running' AND stage = 'classify' AND lease_token = $2 AND lease_until > $5::timestamptz
      RETURNING id
    `, [job.id, job.lease_token, JSON.stringify(result), draft, now.toISOString(), entry("draft_ready", now, job.attempts),
      telemetry ? JSON.stringify(telemetry) : null]);
    return Boolean(saved);
  }

  async fail(job: Job, code: string, transient: boolean, now: Date) {
    const canRetry = transient && job.attempts < maxAttempts;
    const status = canRetry ? "retrying" : "failed";
    const next = new Date(now.getTime() + (canRetry ? 1000 * 2 ** job.attempts : 0));
    const delivery = job.stage === "deliver";
    const step = canRetry ? (delivery ? "delivery_retry_scheduled" : "retry_scheduled")
      : (delivery ? "delivery_failed" : "classification_failed");
    const [saved] = await this.db.query<{ id: string }>(`
      UPDATE runs SET status = $3, error_code = $4, updated_at = $5, available_at = $6,
        trace = trace || $7::jsonb, lease_token = NULL, lease_until = NULL
      WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_until > $5::timestamptz
      RETURNING id
    `, [job.id, job.lease_token, status, code, now.toISOString(), next.toISOString(),
      entry(step, now, job.attempts)]);
    return saved ? status : "stale";
  }

  async finishDelivery(job: Job, now: Date) {
    const [saved] = await this.db.query<{ id: string }>(`
      UPDATE runs SET status = 'completed', updated_at = $3, trace = trace || $4::jsonb,
        lease_token = NULL, lease_until = NULL
      WHERE id = $1 AND status = 'running' AND stage = 'deliver' AND lease_token = $2 AND lease_until > $3::timestamptz
      RETURNING id
    `, [job.id, job.lease_token, now.toISOString(), entry("delivered", now, job.attempts)]);
    return Boolean(saved);
  }

  async recordLocalDelivery({ id, draft }: Notification) {
    await this.db.query("INSERT INTO local_deliveries (run_id, draft) VALUES ($1, $2) ON CONFLICT (run_id) DO NOTHING", [id, draft]);
  }

  async decide(id: string, decision: ReviewDecision, now: Date, target?: string): Promise<Run> {
    const destination = decision === "approve" ? target ?? null : null;
    const next = decision === "approve" ? (destination ? "queued" : "completed") : "rejected";
    const step = decision === "approve" ? "approved" : "rejected";
    const [updated] = await this.db.query<Run>(`
      UPDATE runs SET status = $2, updated_at = $3::text::timestamptz,
        stage = CASE WHEN $5::text IS NULL THEN stage ELSE 'deliver' END,
        action_target = $5, available_at = $3::text::timestamptz,
        attempts = CASE WHEN $5::text IS NULL THEN attempts ELSE 0 END,
        trace = trace || jsonb_build_array(jsonb_build_object('step', $4::text, 'at', $3::text, 'attempt', attempts))
      WHERE id = $1 AND status = 'awaiting_approval'
      RETURNING ${fields}
    `, [id, next, now.toISOString(), step, destination]);
    if (updated) return updated;
    const existing = await this.get(id);
    if (existing.trace.some(entry => entry.step === step)) return existing;
    throw new AppError(409, "review_unavailable");
  }

  async operate(id: string, operation: RunOperation, now: Date): Promise<Run> {
    const retry = operation === "retry";
    const [updated] = await this.db.query<Run>(`
      UPDATE runs SET status = $2, updated_at = $3::text::timestamptz, available_at = $3::text::timestamptz,
        attempts = CASE WHEN $4 THEN 0 ELSE attempts END,
        manual_retries = manual_retries + CASE WHEN $4 THEN 1 ELSE 0 END, error_code = NULL,
        trace = trace || jsonb_build_array(jsonb_build_object('step', $5::text, 'at', $3::text, 'attempt', attempts))
      WHERE id = $1 AND (
        ($4 AND status = 'failed' AND manual_retries < 3)
        OR (NOT $4 AND status IN ('queued', 'retrying', 'awaiting_approval'))
      ) RETURNING ${fields}
    `, [id, retry ? "queued" : "cancelled", now.toISOString(), retry, retry ? "manual_retry" : "cancelled"]);
    if (updated) return updated;
    const existing = await this.get(id);
    if (!retry && existing.status === "cancelled") return existing;
    throw new AppError(409, "operation_unavailable");
  }
}
