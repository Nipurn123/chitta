"use client";
import React, { useState } from "react";
import { SectionHead, Card } from "./ui";
import { api, ApiOffline } from "@/lib/api";

interface Hit {
  content: string;
  recordName: string;
  recordId: string;
  score: number;
  citationType: string;
}
interface Trace {
  counts: { vector: number; keyword: number; graph: number; fused: number };
  reranked: boolean;
  items: { label: string; recordId?: string; legs: string[]; rrf: number; rank: number }[];
}

const LEG_COLOR: Record<string, string> = { vector: "#7c9cff", keyword: "#5eead4", graph: "#f0abfc" };
const LEG_LABEL: Record<string, string> = { vector: "vector db", keyword: "keyword bm25", graph: "graph" };

function Stage({ title, value, sub, dim }: { title: string; value: string | number; sub?: string; dim?: boolean }) {
  return (
    <div className={`flex min-w-[92px] flex-col items-center rounded-xl border border-line bg-panel px-3 py-2.5 ${dim ? "opacity-45" : ""}`}>
      <div className="font-mono text-[20px] font-semibold leading-none text-ink">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.1em] text-faint">{title}</div>
      {sub && <div className="mt-0.5 font-mono text-[9.5px] text-muted">{sub}</div>}
    </div>
  );
}
const Arrow = () => <span className="select-none px-1 font-mono text-[14px] text-faint">→</span>;

function PipelineTrace({ trace }: { trace: Trace }) {
  const c = trace.counts;
  return (
    <Card title="HOW IT RETRIEVED" tag="hybrid pipeline" className="mb-3">
      {/* the flow: three signals → fuse → rerank → passages */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex flex-col gap-1.5">
          <Stage title="vector db" value={c.vector} sub="dense / semantic" dim={c.vector === 0} />
          <Stage title="keyword" value={c.keyword} sub="bm25 / exact" dim={c.keyword === 0} />
          <Stage title="graph" value={c.graph} sub="graphRAG hops" dim={c.graph === 0} />
        </div>
        <Arrow />
        <Stage title="RRF fuse" value={c.fused} sub="reciprocal rank" />
        <Arrow />
        <Stage title="rerank" value={trace.reranked ? "✓" : "-"} sub={trace.reranked ? "cross-encoder" : "off"} dim={!trace.reranked} />
        <Arrow />
        <Stage title="passages" value={trace.items.length} sub="extracted" />
      </div>

      {/* which signals found each top result */}
      <div className="mt-3 border-t border-line pt-2.5">
        <div className="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-faint">signals that found each result</div>
        <div className="flex flex-col gap-1">
          {trace.items.map((it, i) => (
            <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: "16px 1fr auto 56px" }}>
              <span className="text-right font-mono text-[10px] text-faint">{i + 1}</span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-muted" title={it.label}>{it.label}</span>
              <span className="flex gap-1">
                {it.legs.map((leg) => (
                  <span key={leg} className="rounded-md px-1.5 py-0.5 font-mono text-[9px] uppercase" style={{ background: `${LEG_COLOR[leg]}22`, color: LEG_COLOR[leg] }} title={LEG_LABEL[leg]}>
                    {leg}
                  </span>
                ))}
              </span>
              <span className="text-right font-mono text-[10px] text-faint">{it.rrf.toFixed(3)}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
interface Triple {
  subject: string;
  predicate: string;
  object: string;
}
interface Answer {
  answer: string;
  facts: string[];
  triple: Triple;
  citations: string[];
  confidence: number;
}

export function SearchView() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [exact, setExact] = useState<Answer | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "offline" | "error">("idle");

  async function run(query: string) {
    if (!query.trim()) return;
    setState("loading");
    setExact(null);
    try {
      const [s, a] = await Promise.all([
        api<{ results: Hit[]; trace: Trace }>("/api/search", { query }),
        api<{ answer: Answer | null }>("/api/ask", { query }).catch(() => ({ answer: null })),
      ]);
      setHits(s.results);
      setTrace(s.trace ?? null);
      if (a.answer && a.answer.confidence >= 0.7) setExact(a.answer);
      setState("ok");
    } catch (e) {
      setState(e instanceof ApiOffline ? "offline" : "error");
    }
  }

  return (
    <div className="h-full overflow-auto p-5">
      <SectionHead title="Live retrieval" sub="The real backend - hybrid BM25 + dense + graph → RRF → cross-encoder rerank → passage extraction, permission-filtered" />
      <div className="mx-auto max-w-[920px]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(q);
          }}
          className="mb-4 flex gap-2"
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ask the knowledge graph…  (e.g. ‘Google limits Meta Gemini’)"
            className="flex-1 rounded-xl border border-line bg-panel px-4 py-3 text-[13px] text-ink outline-none placeholder:text-faint focus:border-line-2"
          />
          <button type="submit" className="rounded-xl bg-accent/90 px-5 py-3 text-[13px] font-semibold text-[#0b0d12] transition-colors hover:bg-accent">
            search
          </button>
        </form>

        {state === "offline" && (
          <Card title="BACKEND OFFLINE">
            <div className="text-[12.5px] text-muted">
              The retrieval API isn&apos;t running. Start it:
              <pre className="mt-2 rounded-lg border border-line bg-panel-2 p-3 font-mono text-[11.5px] text-ink">bun run context-mcp/src/http/server.ts</pre>
              (first query downloads the embedding + reranker models)
            </div>
          </Card>
        )}
        {state === "error" && <Card title="ERROR"><div className="text-[12.5px] text-[var(--bad,#fca5a5)]">retrieval failed - see API logs.</div></Card>}
        {state === "loading" && <div className="py-10 text-center font-mono text-[12px] text-faint">searching…</div>}

        {state === "ok" && trace && <PipelineTrace trace={trace} />}

        {exact && (
          <Card title={exact.facts && exact.facts.length > 1 ? `EXACT ANSWER · ${exact.facts.length} facts` : "EXACT ANSWER"} tag={`KGQA · conf ${exact.confidence.toFixed(2)}`} className="mb-3 border-[var(--good)]/40">
            {exact.facts && exact.facts.length > 1 ? (
              <ul className="flex flex-col gap-1.5">
                {exact.facts.map((f, i) => (
                  <li key={i} className="flex gap-2 text-[13.5px] leading-relaxed text-ink">
                    <span className="select-none text-accent">•</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[14px] leading-relaxed text-ink">{(exact.facts && exact.facts[0]) || exact.answer}</div>
            )}
            {exact.facts && exact.facts.length === 1 && exact.triple.predicate && !["info", "facts", "prefer"].includes(exact.triple.predicate) && (
              <div className="mt-2 font-mono text-[11.5px] text-accent">
                [{exact.triple.subject} -{exact.triple.predicate}→ {exact.triple.object}]
              </div>
            )}
            {exact.citations.length > 0 && <div className="mt-2 text-[11px] text-faint">source: {exact.citations.join(", ")}</div>}
          </Card>
        )}

        {state === "ok" && hits && (
          <div className="flex flex-col gap-2.5">
            <div className="px-1 text-[11px] uppercase tracking-[0.12em] text-faint">{hits.length} ranked passage{hits.length === 1 ? "" : "s"}</div>
            {hits.length === 0 && <Card><div className="py-4 text-center text-[12px] text-faint">No relevant context found.</div></Card>}
            {hits.map((h, i) => (
              <Card key={h.recordId + i}>
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="font-mono text-[10px] text-faint">{i + 1}</span>
                  <span className="text-[12px] font-semibold text-ink">{h.recordName}</span>
                  <span className="rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wide text-muted">{h.citationType}</span>
                  <span className="ml-auto font-mono text-[10.5px] text-faint">{h.score.toFixed(3)}</span>
                </div>
                <div className="text-[12.5px] leading-relaxed text-muted">{h.content}</div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
