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
    // Attribute each turn with WHO said it + WHEN, so both are part of the SEARCHABLE +
    // ANSWERABLE memory. Dialogue answers are frequently a speaker ("who said X?") or a date
    // ("7 May 2023") that live in session metadata, not the turn text - dropping either makes
    // those questions unanswerable even when the right turn is retrieved. Real memory stores
    // who said what, when; so must this. Format: "Caroline (8 May 2023): I went yesterday".
    const tag = [item.speaker, item.timestamp ? `(${item.timestamp})` : ""].filter(Boolean).join(" ")
    const text = tag ? `${tag}: ${item.text}` : item.text
    fullHistoryTokens += approxTokens(text)
    await ctx.authorizedIngest(userId, {
      recordId: item.id,
      orgId,
      recordName: item.id,
      text,
      permittedPrincipals: [userId],
      entities: item.entities,
      relations: item.relations,
    })
  }
  return { ingestMs: performance.now() - t0, fullHistoryTokens }
}
