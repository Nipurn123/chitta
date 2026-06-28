// Client wire to the REAL backend (the bun HTTP API, src/http/server.ts on :4318).
// The dashboard reads the SQLite directly for VISUALIZATION, but live RETRIEVAL,
// KGQA, PageRank, and eval must run on the bun backend (bun:sqlite + transformers +
// reranker) - those go through here.
export const API_BASE = process.env.NEXT_PUBLIC_API ?? "http://localhost:4318";

export class ApiOffline extends Error {}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  } catch {
    throw new ApiOffline("backend API not reachable");
  }
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}
