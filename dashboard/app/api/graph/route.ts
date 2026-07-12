import { NextResponse } from "next/server";
import { loadGraph } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await loadGraph();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "graph snapshot missing - run `npm run sync`" },
      { status: 503 },
    );
  }
}
