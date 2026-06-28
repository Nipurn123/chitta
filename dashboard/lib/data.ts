// Data loader for the context graph.
//
// Default: read the live SQLite directly on every request (lib/live.ts) so the
// UI reflects DB edits on reload - no snapshot step. If the DB is unavailable,
// fall back to the data/graph.json snapshot (produced by `npm run sync`).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphData } from "./types";
import { liveAvailable, loadGraphLive } from "./live";

export async function loadGraph(): Promise<GraphData> {
  if (liveAvailable()) {
    try {
      return loadGraphLive();
    } catch (e) {
      console.error("[context] live DB read failed, falling back to snapshot:", e);
    }
  }
  const path = join(process.cwd(), "data", "graph.json");
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as GraphData;
}
