import { loadGraph } from "@/lib/data";
import { Dashboard } from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function Page() {
  const data = await loadGraph();
  return <Dashboard data={data} />;
}
