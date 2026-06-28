"use client";
import React, { useMemo, useState } from "react";
import type { GraphData } from "@/lib/types";
import { typeColor } from "@/lib/types";
import { SectionHead, Card } from "./ui";

// Personalized PageRank (HippoRAG-style multi-hop) computed client-side over the LIVE
// typed relations - seeds activation on one entity and spreads it across the whole
// graph; a node reachable via many paths outranks a near dead-end. Mirrors the MCP's
// graphQuery.walk() so the dashboard shows the same multi-hop relevance the agent gets.
function personalizedPageRank(data: GraphData, seedId: string, alpha = 0.85, iters = 30) {
  const ids = data.entities.map((e) => e.id);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const adj: { j: number; w: number }[][] = ids.map(() => []);
  for (const r of data.relations) {
    if (r.live === false) continue; // superseded facts don't drive current relevance
    const a = idx.get(r.from);
    const b = idx.get(r.to);
    if (a === undefined || b === undefined) continue;
    const w = r.weight || 1;
    adj[a].push({ j: b, w });
    adj[b].push({ j: a, w });
  }
  const deg = adj.map((l) => l.reduce((s, e) => s + e.w, 0) || 1);
  const s = idx.get(seedId);
  if (s === undefined) return [] as { id: string; score: number }[];
  const tele = new Float64Array(n);
  tele[s] = 1;
  let rr = Float64Array.from(tele);
  for (let it = 0; it < iters; it++) {
    const nx = new Float64Array(n);
    for (let i = 0; i < n; i++) nx[i] = (1 - alpha) * tele[i];
    for (let i = 0; i < n; i++) {
      if (rr[i] === 0) continue;
      const share = (alpha * rr[i]) / deg[i];
      for (const e of adj[i]) nx[e.j] += share * e.w;
    }
    rr = nx;
  }
  return ids
    .map((id, i) => ({ id, score: rr[i] }))
    .filter((x) => x.id !== seedId && x.score > 1e-6)
    .sort((a, b) => b.score - a.score);
}

export function WalkView({ data }: { data: GraphData }) {
  const byDegree = useMemo(() => [...data.entities].sort((a, b) => b.degree - a.degree), [data.entities]);
  const byId = useMemo(() => new Map(data.entities.map((e) => [e.id, e])), [data.entities]);
  const [seed, setSeed] = useState(() => byDegree[0]?.id ?? "");
  const [q, setQ] = useState("");
  const ranked = useMemo(() => personalizedPageRank(data, seed).slice(0, 25), [data, seed]);
  const seedEnt = byId.get(seed);
  const max = ranked[0]?.score ?? 1;
  const matches = q ? byDegree.filter((e) => e.label.toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];

  return (
    <div className="h-full overflow-auto p-5">
      <SectionHead
        title="Multi-hop walk"
        sub="Personalized PageRank - what's most related to a seed across the WHOLE graph, not just direct neighbors"
      />
      <div className="mx-auto grid max-w-[1240px] gap-4" style={{ gridTemplateColumns: "320px 1fr" }}>
        <div className="flex flex-col gap-3">
          <Card title="SEED" tag="α=0.85 · 30 iters">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search entity…"
              className="mb-2 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12px] text-ink outline-none placeholder:text-faint"
            />
            {matches.length > 0 && (
              <div className="mb-3 flex flex-col gap-1">
                {matches.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => {
                      setSeed(e.id);
                      setQ("");
                    }}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-muted hover:bg-panel-2 hover:text-ink"
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: typeColor(e.type) }} />
                    {e.label}
                  </button>
                ))}
              </div>
            )}
            <div className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-faint">top hubs</div>
            <div className="flex flex-wrap gap-1.5">
              {byDegree.slice(0, 8).map((e) => (
                <button
                  key={e.id}
                  onClick={() => setSeed(e.id)}
                  className={`rounded-md px-2 py-1 text-[11.5px] transition-colors ${
                    seed === e.id
                      ? "bg-panel-2 text-ink shadow-[inset_0_0_0_1px_var(--line-2)]"
                      : "text-muted hover:bg-panel-2 hover:text-ink"
                  }`}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </Card>
          {seedEnt && (
            <Card title="SEED ENTITY">
              <div className="flex items-center gap-2.5">
                <span className="h-3 w-3 rounded-full" style={{ background: typeColor(seedEnt.type) }} />
                <span className="text-[15px] font-semibold text-ink">{seedEnt.label}</span>
              </div>
              <div className="mt-1.5 font-mono text-[11px] text-faint">
                {seedEnt.type.toLowerCase()} · {seedEnt.degree} direct link{seedEnt.degree === 1 ? "" : "s"}
              </div>
            </Card>
          )}
        </div>

        <Card title={`MOST RELATED TO ${seedEnt?.label ?? "-"}`} tag={`${ranked.length} ranked`}>
          {ranked.length === 0 ? (
            <div className="py-10 text-center text-[12px] text-faint">No connections from this entity.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {ranked.map((r, i) => {
                const e = byId.get(r.id);
                return (
                  <div key={r.id} className="grid items-center gap-3" style={{ gridTemplateColumns: "18px 200px 1fr 56px" }}>
                    <span className="text-right font-mono text-[11px] text-faint">{i + 1}</span>
                    <button onClick={() => setSeed(r.id)} className="flex items-center gap-2 overflow-hidden text-left" title={`walk from ${e?.label}`}>
                      <span className="h-2 w-2 flex-none rounded-full" style={{ background: typeColor(e?.type ?? "DEFAULT") }} />
                      <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-muted hover:text-ink">{e?.label ?? r.id}</span>
                    </button>
                    <div className="h-2 overflow-hidden rounded-[5px] bg-panel-2">
                      <div
                        className="animate-grow h-full rounded-[5px]"
                        style={{ width: `${(r.score / max) * 100}%`, background: "linear-gradient(90deg,#7c9cff,#5eead4)", animationDelay: `${i * 30}ms` }}
                      />
                    </div>
                    <span className="text-right font-mono text-[11px] text-ink">{r.score.toFixed(3)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 border-t border-line pt-2.5 text-[11px] text-faint">
            click any result to walk from it · scores = stationary PageRank mass over live typed edges
          </div>
        </Card>
      </div>
    </div>
  );
}
