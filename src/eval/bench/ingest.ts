// Ingest phase - load one benchmark case's HISTORY into a fresh memory. Each history item
// becomes one record whose id IS the evidence label, so Tier-A scoring can ask "did the
// memory rank the right record for this question?". Typed entities/relations (when the
// dataset supplies them) go in too, so belief revision / contradiction resolution is
// exercised. Returns timing + the full-history token count (the denominator of the
// token-reduction ratio).

import type { EmbeddedContext } from "../../embedded/index"
import type { BenchmarkCase } from "../datasets/types"
import { approxTokens } from "./types"

export async function ingestCase(
  ctx: EmbeddedContext,
  c: BenchmarkCase,
  userId: string,
  orgId: string,
): Promise<{ ingestMs: number; fullHistoryTokens: number }> {
  const t0 = performance.now()
  let fullHistoryTokens = 0
  for (const item of c.history) {
    fullHistoryTokens += approxTokens(item.text)
    await ctx.authorizedIngest(userId, {
      recordId: item.id,
      orgId,
      recordName: item.id,
      text: item.text,
      permittedPrincipals: [userId],
      entities: item.entities,
      relations: item.relations,
    })
  }
  return { ingestMs: performance.now() - t0, fullHistoryTokens }
}
