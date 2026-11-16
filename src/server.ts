import { createApi } from "./api";
import { openDatabase } from "./database";
import { readSettings } from "./settings";
import { RunStore } from "./store";

const instance = globalThis as typeof globalThis & { flowpulseStore?: Promise<RunStore> };

async function getStore(): Promise<RunStore> {
  instance.flowpulseStore ??= openDatabase({
    url: process.env.DATABASE_URL,
    path: process.env.DATABASE_PATH || "data/flowpulse"
  }).then(database => new RunStore(database)).catch(error => {
    instance.flowpulseStore = undefined;
    throw error;
  });
  return instance.flowpulseStore;
}

export const handle = createApi({ settings: readSettings, store: getStore });
