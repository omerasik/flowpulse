export type Notification = { id: string; draft: string };

export interface NotificationConnector {
  target: string;
  send(notification: Notification): Promise<void>;
}

export class DeliveryError extends Error {
  constructor(public readonly code: string, public readonly transient: boolean) {
    super(code);
  }
}

export function webhookConnector(endpoint: string, token: string, fetcher: typeof fetch = fetch): NotificationConnector {
  return {
    target: endpoint,
    async send(notification) {
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
            "Idempotency-Key": notification.id
          },
          body: JSON.stringify({ runId: notification.id, message: notification.draft })
        });
      } catch {
        throw new DeliveryError("delivery_unreachable", true);
      }
      if (response.body) void response.body.cancel().catch(() => undefined);
      if (response.ok) return;
      const transient = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new DeliveryError(transient ? "delivery_unavailable" : "delivery_rejected", transient);
    }
  };
}
