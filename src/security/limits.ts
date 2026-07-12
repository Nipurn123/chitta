// Ingest guardrails: size caps + an in-process token-bucket rate limiter. Bounds the
// blast radius of a single huge/poisoned document and prevents an MCP client from
// wedging the server with a flood of ingests. Zero dependencies; per-process state is
// fine for a stdio MCP server. Caps are env-overridable for power users.

export const MAX_INGEST_BYTES = Number(process.env.CHITTA_MAX_INGEST_BYTES ?? 10 * 1024 * 1024) // 10 MB
export const MAX_CHUNKS = Number(process.env.CHITTA_MAX_CHUNKS ?? 5000)

export class TokenBucket {
  private tokens: number
  private last = Date.now()
  constructor(private readonly capacity: number, private readonly refillPerSec: number) {
    this.tokens = capacity
  }
  /** Consume `cost` tokens if available; returns false (no throw) when rate-limited. */
  tryRemove(cost = 1): boolean {
    const now = Date.now()
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec)
    this.last = now
    if (this.tokens >= cost) {
      this.tokens -= cost
      return true
    }
    return false
  }
}

// 30-ingest burst, 10/sec sustained - generous for humans/agents, lethal to a flood.
const ingestLimiter = new TokenBucket(
  Number(process.env.CHITTA_INGEST_BURST ?? 30),
  Number(process.env.CHITTA_INGEST_RATE ?? 10),
)

export class IngestLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IngestLimitError"
  }
}

/** SIZE cap only - stateless, safe to call on EVERY ingest (incl. bulk/internal/tests).
 *  Throws IngestLimitError when a single payload exceeds the byte cap. */
export function guardIngest(text: string): void {
  const bytes = Buffer.byteLength(text ?? "", "utf8")
  if (bytes > MAX_INGEST_BYTES) {
    throw new IngestLimitError(
      `ingest too large: ${bytes} bytes > ${MAX_INGEST_BYTES} (set CHITTA_MAX_INGEST_BYTES to raise)`,
    )
  }
}

/** RATE limit - stateful; call ONLY at the external MCP boundary (context_ingest tool),
 *  NOT in the core ingest method (bulk/reindex/tests legitimately burst). Cost scales
 *  with payload size so one 10 MB doc counts as ~10 small ones. */
export function rateLimitIngest(text: string): void {
  const bytes = Buffer.byteLength(text ?? "", "utf8")
  const cost = Math.max(1, Math.ceil(bytes / (1024 * 1024)))
  if (!ingestLimiter.tryRemove(cost)) {
    throw new IngestLimitError("ingest rate limit exceeded - slow down or raise CHITTA_INGEST_RATE")
  }
}
