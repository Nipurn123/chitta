"use client";
import React, { useState } from "react";
import { SectionHead, Card, Stat } from "./ui";
import { api, ApiOffline } from "@/lib/api";

interface PerQ {
  query: string;
  recall: number;
  precision: number;
  ndcg: number;
  rr: number;
  missed: boolean;
}
interface Report {
  n: number;
  k: number;
  recall: number;
  ndcg: number;
  mrr: number;
  precision: number;
  perQuery: PerQ[];
}

export function EvalView() {
  const [report, setReport] = useState<Report | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "offline" | "error">("idle");

  async function run() {
    setState("loading");
    try {
      const r = await api<{ report: Report }>("/api/eval");
      setReport(r.report);
      setState("ok");
    } catch (e) {
      setState(e instanceof ApiOffline ? "offline" : "error");
    }
  }

  return (
    <div className="h-full overflow-auto p-5">
      <SectionHead title="Retrieval quality" sub="Measured, not eyeballed - a gold set auto-built from your own records, scored by the real retrieval pipeline" />
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-4 flex items-center gap-3">
          <button
            onClick={run}
            disabled={state === "loading"}
            className="rounded-xl bg-accent/90 px-5 py-2.5 text-[13px] font-semibold text-[#0b0d12] transition-colors hover:bg-accent disabled:opacity-50"
          >
            {state === "loading" ? "running…" : report ? "re-run eval" : "run eval"}
          </button>
          <span className="font-mono text-[11px] text-faint">recall@k · nDCG@k · MRR over an auto-generated gold set</span>
        </div>

        {state === "offline" && (
          <Card title="BACKEND OFFLINE">
            <pre className="rounded-lg border border-line bg-panel-2 p-3 font-mono text-[11.5px] text-ink">bun run context-mcp/src/http/server.ts</pre>
          </Card>
        )}
        {state === "error" && <Card title="ERROR"><div className="text-[12.5px] text-[var(--bad,#fca5a5)]">eval failed - see API logs.</div></Card>}

        {report && (
          <>
            <div className="mb-4 grid grid-cols-4 gap-3">
              <Stat label={`recall@${report.k}`} value={report.recall.toFixed(3)} sub="did the right record come back?" />
              <Stat label={`nDCG@${report.k}`} value={report.ndcg.toFixed(3)} sub="is it ranked well?" />
              <Stat label="MRR" value={report.mrr.toFixed(3)} sub="is it #1?" />
              <Stat label="queries" value={report.n} sub={`${report.perQuery.filter((p) => p.missed).length} misses`} />
            </div>
            <Card title="PER-QUERY" tag={`top-${report.k}`}>
              <div className="flex flex-col gap-1.5">
                {report.perQuery.map((p, i) => (
                  <div key={i} className="grid items-center gap-3 border-b border-line/40 pb-1.5 last:border-0" style={{ gridTemplateColumns: "1fr 70px 70px 60px" }}>
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-muted" title={p.query}>
                      <span className={p.missed ? "text-[var(--bad,#fca5a5)]" : "text-[var(--good)]"}>{p.missed ? "✗" : "✓"}</span> {p.query}
                    </span>
                    <span className="text-right font-mono text-[11px] text-faint">r {p.recall.toFixed(2)}</span>
                    <span className="text-right font-mono text-[11px] text-faint">n {p.ndcg.toFixed(2)}</span>
                    <span className="text-right font-mono text-[11px] text-ink">rr {p.rr.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
