// Local OpenAI-compatible endpoint in front of Vertex AI Gemini, for benchmark runs on a GCE VM.
// Chitta's LLM client sends a fixed bearer key, but Google access tokens expire after ~1h - longer
// than a full LLM-mode run. This proxy fetches a fresh token from the VM's metadata server (the VM
// needs the cloud-platform scope) and retries 429/5xx with backoff, so concurrent ingest survives
// rate limits. Point Chitta at it:  CONTEXT_LLM_URL=http://127.0.0.1:8790 CONTEXT_LLM_MODEL=google/gemini-3.8-flash
// usage: VERTEX_PROJECT=<id> [VERTEX_LOCATION=global] bun run vertex-proxy.ts [port]
const project = process.env.VERTEX_PROJECT
if (!project) throw new Error("set VERTEX_PROJECT")
const location = process.env.VERTEX_LOCATION ?? "global"
const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
const upstream = `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi/chat/completions`
const port = Number(process.argv[2] ?? 8790)

let tok = { value: "", exp: 0 }
async function token(): Promise<string> {
  if (Date.now() < tok.exp - 120_000) return tok.value
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" },
  })
  const j = (await r.json()) as { access_token: string; expires_in: number }
  tok = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 }
  return tok.value
}

let calls = 0
let retries = 0
let failed = 0 // gave up after every retry - the caller saw an error, so its answer is suspect
// Token accounting from each response's `usage`, per model, so a run's spend is measured, not
// guessed. OUTPUT counts thinking tokens too: Gemini bills them as output but reports them apart
// from completion_tokens (completion_tokens_details.reasoning_tokens) - counting completion alone
// under-reported spend several-fold. List prices per 1M tokens (third-party trackers, 2026-10).
const PRICES: Record<string, [number, number]> = {
  "google/gemini-3.8-flash": [0.75, 3.75],
  "google/gemini-3.1-pro-preview": [2, 12],
  "google/gemini-3.5-flash-lite": [0.1, 0.4],
}
const usage = new Map<string, { inTok: number; outTok: number }>()
function account(body: string, text: string): void {
  try {
    const model = (JSON.parse(body) as { model?: string }).model ?? "?"
    const u = (JSON.parse(text) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
    }).usage
    if (!u) return
    const m = usage.get(model) ?? usage.set(model, { inTok: 0, outTok: 0 }).get(model)!
    const inTok = u.prompt_tokens ?? 0
    m.inTok += inTok
    m.outTok += u.total_tokens != null ? u.total_tokens - inTok : (u.completion_tokens ?? 0) + (u.completion_tokens_details?.reasoning_tokens ?? 0)
  } catch {
    /* non-JSON error bodies carry no usage */
  }
}
function spend(): string {
  let total = 0
  const parts = [...usage].map(([m, u]) => {
    const [pi, po] = PRICES[m] ?? [0.75, 3.75]
    const cost = (u.inTok * pi + u.outTok * po) / 1e6
    total += cost
    return `${m}: ${(u.inTok / 1e6).toFixed(2)}M in, ${(u.outTok / 1e6).toFixed(2)}M out ≈ $${cost.toFixed(2)}`
  })
  return `${parts.join("; ")} | total ≈ $${total.toFixed(2)}`
}
Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    const body = await req.text()
    calls++
    // Up to 25 attempts (~20 min), backoff capped at 60 s with jitter (so a burst of rate-limited
    // callers doesn't retry in lockstep). A quota-bound run should slow down, not lose answers -
    // 10 attempts lost 170 of ~1,900 calls in a congested hour.
    for (let attempt = 0; attempt < 25; attempt++) {
      const r = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
        body,
      }).catch(() => null)
      if (!r || r.status === 429 || r.status >= 500) {
        retries++
        await Bun.sleep(Math.min(60_000, 1500 * 2 ** attempt) * (0.5 + Math.random()))
        continue
      }
      const text = await r.text()
      account(body, text)
      return new Response(text, { status: r.status, headers: { "content-type": "application/json" } })
    }
    failed++
    return new Response(JSON.stringify({ error: "upstream kept failing" }), { status: 503 })
  },
})
setInterval(() => console.log(`[vertex-proxy] ${calls} calls, ${retries} retries, ${failed} FAILED | ${spend()}`), 60_000)
console.log(`[vertex-proxy] :${port} -> ${upstream}`)
