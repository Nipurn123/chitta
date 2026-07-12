#!/usr/bin/env bun
// HTTP API over the REAL embedded backend - the dashboard's live wire. The backend
// uses bun:sqlite + in-process transformers/reranker, so it can't run inside the
// Next.js (Node) dashboard; this small bun server exposes it over HTTP (CORS-open for
// localhost) so the UI drives genuine retrieval: hybrid BM25+dense+graph → RRF →
// reranker → passage, KGQA exact answers, Personalized PageRank, and the eval harness.
// Identity comes from the same CONTEXT_USER_ID/ORG_ID env as the MCP (single-user by
// default). Run: bun run src/http/server.ts  (port CONTEXT_HTTP_PORT, default 4318).

import { personalContext } from "../embedded/personal"
import { generateGoldSet } from "../eval/goldset"
import { evaluate } from "../eval/harness"

const ctx = personalContext()
const U = ctx.userId
const O = ctx.orgId
const PORT = Number(process.env.CONTEXT_HTTP_PORT ?? 4318)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "content-type": "application/json",
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: CORS })

Bun.serve({
  port: PORT,
  idleTimeout: 60, // retrieval can download a model on first call
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS })
    const url = new URL(req.url)
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {}
    try {
      switch (url.pathname) {
        case "/api/health":
          return json({ ok: true, user: U, org: O })

        // hybrid retrieval (BM25 + dense + graph → RRF → reranker → passage) + TRACE
        case "/api/search": {
          const { response, trace } = await ctx.searchTraced(String(body.query ?? ""), U, O)
          return json({
            query: body.query,
            results: response.searchResults.map((r) => ({
              content: r.content,
              recordName: r.metadata.recordName ?? "untitled",
              recordId: r.metadata.recordId,
              score: r.score,
              citationType: r.citationType,
            })),
            trace, // how the query flowed through the pipeline
          })
        }

        // KGQA exact answer from the typed graph (null ⇒ fell back to ranked)
        case "/api/ask":
          return json({ answer: await ctx.ask(String(body.query ?? ""), U, O) })

        // Personalized PageRank multi-hop walk
        case "/api/walk": {
          const seeds = Array.isArray(body.seeds)
            ? body.seeds
            : String(body.seed ?? "").split(/\s*,\s*/).filter(Boolean)
          return json({ ranked: await ctx.graphQuery.walk(seeds, U, O, { limit: 25 }) })
        }
        case "/api/neighbors":
          return json({ result: await ctx.graphQuery.neighbors(String(body.entity ?? ""), U, O) })
        case "/api/path":
          return json({ result: await ctx.graphQuery.pathBetween(String(body.a ?? ""), String(body.b ?? ""), U, O) })
        case "/api/communities":
          return json({ communities: await ctx.graphQuery.communities(U, O) })

        // measure retrieval quality on a gold set auto-built from the user's own data
        case "/api/eval": {
          const gold = generateGoldSet(ctx.store, { terms: 6 })
          const report = await evaluate(
            gold,
            async (q) => (await ctx.searchWithGraph(q, U, O)).searchResults.map((r) => r.metadata.recordId as string),
            10,
          )
          return json({ report })
        }

        default:
          return json({ error: "not found", paths: ["/api/health", "/api/search", "/api/ask", "/api/walk", "/api/neighbors", "/api/path", "/api/communities", "/api/eval"] }, 404)
      }
    } catch (e) {
      return json({ error: String(e) }, 500)
    }
  },
})

console.error(`[context-http] backend API ready on http://localhost:${PORT} (user=${U}, org=${O})`)
