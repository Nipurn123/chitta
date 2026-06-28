// Signal 1: DENSE (vector + ACL) - semantic similarity (paraphrase, meaning).
import type { RetrievalService } from "../../retrieval"
import type { SearchResult } from "../../types"

export async function vectorStage(
  retrieval: RetrievalService,
  query: string,
  userId: string,
  orgId: string,
  retrieveLimit: number,
): Promise<{ dense: SearchResult[]; res: Awaited<ReturnType<RetrievalService["searchWithFilters"]>> }> {
  const res = await retrieval.searchWithFilters({ queries: [query], userId, orgId, limit: retrieveLimit })
  const dense: SearchResult[] = [...res.searchResults]
  return { dense, res }
}
