import { Home } from "../components/home.tsx";
import { getProcessorNames } from "../lib/runtime.ts";

export const dynamic = "force-dynamic";
export default async function Page() {
  const processors = await getProcessorNames();
  return <Home processors={processors} />;
}
