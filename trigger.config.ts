import { defineConfig } from "@trigger.dev/sdk";

const project = process.env.TRIGGER_PROJECT_REF;
if (!project) throw new Error("Set TRIGGER_PROJECT_REF before running the Trigger.dev CLI.");

export default defineConfig({
  project,
  dirs: ["./trigger"],
  runtime: "node-22",
  maxDuration: 300
});
