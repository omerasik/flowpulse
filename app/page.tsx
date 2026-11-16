import { Dashboard } from "./dashboard";

export const dynamic = "force-dynamic";

export default function Page() {
  const localDemo = process.env.DEMO_MODE === "true" && !process.env.OPERATOR_TOKEN;
  return <Dashboard localDemo={localDemo} />;
}
