import { modelClassifier } from "./provider";
import { classifyWithRules, ClassificationError } from "./worker";

export const demoOperator = "flowpulse-local-demo";
const demoWebhook = "flowpulse-local-webhook";
const demoWorker = "flowpulse-local-worker";

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
    classify = modelClassifier({ endpoint: endpoint.href, key: env.AI_API_KEY, model: env.AI_MODEL });
  }

  return {
    demo, operatorToken, webhookSecret, workerToken, provider,
    classify: demo ? async (event: Parameters<typeof classify>[0], attempt: number) => {
      if (attempt === 1 && event.id.startsWith("demo-retry-")) throw new ClassificationError("demo_transient", true);
      return classify(event, attempt);
    } : classify
  };
}

export type Settings = ReturnType<typeof readSettings>;
