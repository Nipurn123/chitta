"use client";
import React from "react";
import type { GraphData } from "@/lib/types";
import { Card, SectionHead } from "./ui";

const STEPS: [string, string, string][] = [
  ["ingest", "#f0abfc", "text in"],
  ["ACL edges", "#7c9cff", "permission graph"],
  ["chunk + embed", "#5eead4", "vectors"],
  ["extract", "#86efac", "entities + relations"],
  ["ACL traverse", "#7c9cff", "who may see?"],
  ["vector search", "#5eead4", "restricted ANN"],
  ["leak guard", "#fbbf77", "cited snippets"],
];

const CARDS: [string, string, React.ReactNode][] = [
  [
    "Build once",
    "ingest",
    <>
      Every document becomes a record node, permission edges (ACL), embedded chunks, and an
      extracted concept sub-graph - atomically, in one SQLite file.
    </>,
  ],
  [
    "Walk per query",
    "retrieve",
    <>
      ACL traversal resolves the accessible record set first; vector search is constrained to it.
      GraphRAG can expand results along <code className="rounded bg-panel-2 px-1.5 py-px font-mono text-[11.5px] text-ink">relates_to</code> edges.
    </>,
  ],
  [
    "Close the leak",
    "guarantee",
    <>
      Each <code className="rounded bg-panel-2 px-1.5 py-px font-mono text-[11.5px] text-ink">virtualRecordId</code> maps to the single record the caller may see - the
      cross-connector leak guard. Superseded facts (<code className="rounded bg-panel-2 px-1.5 py-px font-mono text-[11.5px] text-ink">expired_at</code>) never surface.
    </>,
  ],
];

export function PipelineView({ data }: { data: GraphData }) {
  const W = 1180,
    H = 180,
    n = STEPS.length,
    gap = W / n,
    mid = H / 2;
  const cx = (i: number) => gap / 2 + i * ((W - gap) / (n - 1));

  return (
    <div className="scrollbar absolute inset-0 overflow-auto p-[22px]">
      <SectionHead
        title="Retrieval pipeline"
        sub="ingest builds it · query walks it · the leak guard closes it"
      />
      <div className="mx-auto mb-1.5 max-w-[1240px]">
        <Card>
          <div className="w-full overflow-auto">
            <svg viewBox={`0 0 ${W} ${H}`} width={W} className="mx-auto block max-w-full">
              <line x1={gap / 2} y1={mid} x2={W - gap / 2} y2={mid} stroke="#262a33" strokeWidth={1.5} />
              <circle r={4} fill="#fff">
                <animateMotion
                  dur="4.5s"
                  repeatCount="indefinite"
                  path={`M${gap / 2},${mid} L${W - gap / 2},${mid}`}
                />
                <animate attributeName="opacity" values="0;1;1;1;0" dur="4.5s" repeatCount="indefinite" />
              </circle>
              {STEPS.map(([nm, c, sub], i) => (
                <g key={nm}>
                  <circle cx={cx(i)} cy={mid} r={7} fill="#0e1014" stroke={c} strokeWidth={2} />
                  <circle cx={cx(i)} cy={mid} r={2.5} fill={c} />
                  <text x={cx(i)} y={mid - 26} textAnchor="middle" fontSize={12.5} fontWeight={600} fill="#e8eaf0">
                    {nm}
                  </text>
                  <text x={cx(i)} y={mid + 34} textAnchor="middle" fontSize={10.5} fontFamily="var(--font-mono)" fill="#878d9a">
                    {sub}
                  </text>
                  <text x={cx(i)} y={mid + 50} textAnchor="middle" fontSize={9.5} fontFamily="var(--font-mono)" fill="#5a6070">
                    {String(i + 1).padStart(2, "0")}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        </Card>
      </div>

      <div className="mx-auto grid max-w-[1240px] grid-cols-3 gap-3.5">
        {CARDS.map(([h, t, body]) => (
          <Card key={h} title={h} tag={t}>
            <p className="max-w-[640px] text-[12.5px] leading-[1.6] text-muted">{body}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
