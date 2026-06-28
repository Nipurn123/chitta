"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GraphData } from "@/lib/types";
import { GraphView } from "./GraphView";
import { StructuresView } from "./StructuresView";
import { VectorsView } from "./VectorsView";
import { AccessView } from "./AccessView";
import { PipelineView } from "./PipelineView";
import { WalkView } from "./WalkView";
import { SearchView } from "./SearchView";
import { EvalView } from "./EvalView";

type Tab = "search" | "graph" | "walk" | "struct" | "vectors" | "access" | "eval" | "pipe";
const TABS: { id: Tab; label: string }[] = [
  { id: "search", label: "Search" },
  { id: "graph", label: "Graph" },
  { id: "walk", label: "Walk" },
  { id: "struct", label: "Structures" },
  { id: "vectors", label: "Vectors" },
  { id: "access", label: "Access" },
  { id: "eval", label: "Eval" },
  { id: "pipe", label: "Pipeline" },
];

// cheap content signature - ignores generatedAt (always changes) so we only
// re-render when the DB content actually changed.
function sig(d: GraphData): string {
  return JSON.stringify([
    d.meta.counts,
    d.meta.dbBytes,
    d.nodesByColl,
    d.edgesByLabel,
    d.entityTypes,
    d.vectors?.count,
  ]);
}

export function Dashboard({ data: initial }: { data: GraphData }) {
  const [tab, setTab] = useState<Tab>("graph");
  const [data, setData] = useState<GraphData>(initial);
  const [live, setLive] = useState(true);
  const [flash, setFlash] = useState(false);
  const sigRef = useRef(sig(initial));
  const c = data.meta.counts;
  const mb = (data.meta.dbBytes / 1048576).toFixed(1);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/graph", { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as GraphData;
      const ns = sig(next);
      if (ns !== sigRef.current) {
        sigRef.current = ns;
        setData(next);
        setFlash(true);
        setTimeout(() => setFlash(false), 1200);
      }
    } catch {
      /* ignore transient poll errors */
    }
  }, []);

  // auto-poll the live DB every 4s
  useEffect(() => {
    if (!live) return;
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [live, refresh]);

  return (
    <div className="relative z-[1] flex h-full flex-col">
      <header className="flex h-[52px] flex-none items-center gap-[18px] border-b border-line px-5">
        <div className="flex items-center gap-[11px] font-semibold tracking-[0.2px]">
          <span
            className="h-[9px] w-[9px] rounded-full bg-accent"
            style={{
              boxShadow:
                "0 0 0 4px rgba(124,156,255,.12),0 0 16px rgba(124,156,255,.6)",
            }}
          />
          context
          <small className="font-mono text-[11px] font-medium text-faint">
            knowledge&nbsp;graph
          </small>
        </div>
        <nav className="ml-1.5 flex gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-[13px] py-[7px] text-[12.5px] tracking-[0.2px] transition-colors ${
                tab === t.id
                  ? "bg-panel-2 text-ink shadow-[inset_0_0_0_1px_var(--line-2)]"
                  : "text-muted hover:bg-panel hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="flex-1" />
        <button
          onClick={() => setLive((v) => !v)}
          title={live ? "live - auto-refreshing every 4s (click to pause)" : "paused (click to resume live)"}
          className={`flex items-center gap-[6px] rounded-[7px] border px-[9px] py-[5px] font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
            live ? "border-line text-muted hover:text-ink" : "border-line text-faint hover:text-muted"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${live ? "bg-[var(--good)] animate-pulse" : "bg-faint"}`}
            style={live ? { boxShadow: "0 0 8px var(--good)" } : undefined}
          />
          {live ? "live" : "paused"}
        </button>
        <div
          className={`flex items-center gap-[7px] rounded-[7px] border px-[9px] py-[5px] font-mono text-[11px] text-muted transition-colors duration-500 ${
            flash ? "border-[var(--good)]" : "border-line"
          }`}
        >
          <span>
            <b className="font-semibold text-ink">{c.entities}</b> entities ·{" "}
            <b className="font-semibold text-ink">{c.relations}</b> relations ·{" "}
            <b className="font-semibold text-ink">{c.records}</b> records ·{" "}
            <b className="font-semibold text-ink">{mb}</b> MB
          </span>
        </div>
      </header>

      <main className="relative flex-1 overflow-hidden">
        <Pane on={tab === "search"}>
          <SearchView />
        </Pane>
        <Pane on={tab === "graph"} mount>
          <GraphView data={data} />
        </Pane>
        <Pane on={tab === "walk"}>
          <WalkView data={data} />
        </Pane>
        <Pane on={tab === "struct"}>
          <StructuresView data={data} />
        </Pane>
        <Pane on={tab === "vectors"}>
          <VectorsView data={data} />
        </Pane>
        <Pane on={tab === "access"}>
          <AccessView data={data} />
        </Pane>
        <Pane on={tab === "eval"}>
          <EvalView />
        </Pane>
        <Pane on={tab === "pipe"}>
          <PipelineView data={data} />
        </Pane>
      </main>
    </div>
  );
}

// Graph stays mounted (preserve simulation); others mount lazily on first view.
function Pane({
  on,
  mount,
  children,
}: {
  on: boolean;
  mount?: boolean;
  children: React.ReactNode;
}) {
  const [seen, setSeen] = useState(false);
  if (on && !seen) setSeen(true);
  if (!mount && !seen) return null;
  return (
    <div className="absolute inset-0" style={{ display: on ? "block" : "none" }}>
      {children}
    </div>
  );
}
