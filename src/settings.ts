import { modelClassifier } from "./provider";
import type { ModelPricing } from "./provider";
import { webhookConnector } from "./connector";
import type { NotificationConnector } from "./connector";
import type { RunStore } from "./store";
import { classifyWithRules, ClassificationError } from "./worker";

export const demoOperator = "flowpulse-local-demo";
const demoWebhook = "flowpulse-local-webhook";
const demoWorker = "flowpulse-local-worker";

function readPricing(env: Record<string, string | undefined>): ModelPricing | undefined {
  const input = env.AI_INPUT_USD_PER_MILLION;
  const output = env.AI_OUTPUT_USD_PER_MILLION;
  if (input === undefined && output === undefined) return undefined;
  if (!input?.trim() || !output?.trim()) throw new Error("Both model prices must be configured");
  const inputUsdPerMillion = Number(input);
  const outputUsdPerMillion = Number(output);
  if ([inputUsdPerMillion, outputUsdPerMillion].some(price => !Number.isFinite(price) || price < 0 || price > 100_000)) {
    throw new Error("Invalid model price");
  }
  return { inputUsdPerMillion, outputUsdPerMillion };
}

export function readSettings(env: Record<string, string | undefined> = process.env) {
  const demo = env.DEMO_MODE === "true";
  const operatorToken = env.OPERATOR_TOKEN || (demo ? demoOperator : "");
  const webhookSecret = env.WEBHOOK_SECRET || (demo ? demoWebhook : "");
  const workerToken = env.WORKER_TOKEN || (demo ? demoWorker : "");
  const secrets = [operatorToken, webhookSecret, workerToken];

  if ((!demo && secrets.some(secret => secret.length < 32)) || new Set(secrets).size !== 3) {
    throw new Error("Invalid FlowPulse secrets");
  }
  const provider = env.AI_PROVIDER || "rules";
  if (provider !== "rules" && provider !== "openai") throw new Error("Invalid AI provider");

  let classify = classifyWithRules;
  if (provider === "openai") {
    const endpoint = new URL(env.AI_ENDPOINT || "https://api.openai.com/v1/chat/completions");
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || !env.AI_API_KEY || !env.AI_MODEL) {
      throw new Error("Invalid model configuration");
    }
    classify = modelClassifier({ endpoint: endpoint.href, key: env.AI_API_KEY, model: env.AI_MODEL, pricing: readPricing(env) });
  }

  let connectorFor: ((store: RunStore) => NotificationConnector) | undefined;
  let actionTarget: string | undefined;
  const connector = env.ACTION_CONNECTOR || "none";
  if (connector === "local" && demo) {
    actionTarget = "Local delivery inbox";
    connectorFor = store => ({ target: "Local delivery inbox", send: notice => store.recordLocalDelivery(notice) });
  } else if (connector === "webhook") {
    const endpoint = new URL(env.ACTION_WEBHOOK_URL ?? "");
    const token = env.ACTION_WEBHOOK_TOKEN;
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        endpoint.href.length > 250 || !token || token.length < 32) {
      throw new Error("Invalid notification webhook configuration");
    }
    actionTarget = endpoint.href;
    connectorFor = () => webhookConnector(endpoint.href, token);
  } else if (connector !== "none") {
    throw new Error("Invalid action connector");
  }

  return {
    demo, operatorToken, webhookSecret, workerToken, provider, connectorFor, actionTarget,
    classify: demo ? async (event: Parameters<typeof classify>[0], attempt: number) => {
      if (attempt === 1 && event.id.startsWith("demo-retry-")) throw new ClassificationError("demo_transient", true);
      return classify(event, attempt);
    } : classify
  };
}

export type Settings = ReturnType<typeof readSettings>;
