"use client";
import React from "react";
import type { GraphData } from "@/lib/types";
import { Card, Stat, Bars, Donut, SectionHead } from "./ui";

const SCHEMA: [string, string, [string, string, boolean?][]][] = [
  ["nodes", "idx_nodes_coll", [["id", "TEXT PK", true], ["coll", "TEXT"], ["data", "TEXT/json"]]],
  [
    "edges",
    "src·dst·label PK",
    [
      ["src", "TEXT", true],
      ["dst", "TEXT", true],
      ["label", "TEXT"],
      ["weight", "REAL"],
      ["confidence", "REAL"],
      ["valid_at", "INT"],
      ["expired_at", "INT"],
      ["provenance", "json"],
    ],
  ],
  [
    "chunks",
    "text + vector",
    [["id", "TEXT PK", true], ["vrid", "TEXT"], ["orgId", "TEXT"], ["text", "TEXT"], ["embedding", "BLOB"]],
  ],
  ["vec_chunks", "sqlite-vec ANN", [["rowid", "INT", true], ["embedding", "vec0"]]],
];

export function StructuresView({ data }: { data: GraphData }) {
  const c = data.meta.counts;
  const mb = (data.meta.dbBytes / 1048576).toFixed(1);
  const stats: [string, string | number, string][] = [
    ["entities", c.entities, "graph vertices"],
    ["relations", c.relations, `${c.predicates} predicates`],
    ["records", c.records, "source docs"],
    ["chunks", c.chunks, "embedded"],
    ["mentions", c.mentions, "doc→concept"],
    ["db size", mb + "MB", data.meta.vecEnabled ? "vec0 ANN on" : "brute-force cosine"],
  ];

  return (
    <div className="scrollbar absolute inset-0 overflow-auto p-[22px]">
      <SectionHead
        title="Data structures"
        sub="everything in one SQLite file · nodes · edges · chunks · ANN index"
      />
      <div
        className="mx-auto mb-1.5 grid max-w-[1240px] gap-3.5"
        style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}
      >
        {stats.map(([l, v, s]) => (
          <Stat key={l} label={l} value={v} sub={s} />
        ))}
      </div>

      <div className="mx-auto mb-1.5 grid max-w-[1240px] grid-cols-2 gap-3.5">
        <Card title="Nodes by collection" tag="nodes.coll">
          <Bars rows={data.nodesByColl.map((r) => [r.coll, r.n])} />
        </Card>
        <Card title="Edges by label" tag="edges.label">
          <Bars rows={data.edgesByLabel.slice(0, 9).map((r) => [r.label, r.n])} warm />
        </Card>
      </div>

      <div
        className="mx-auto grid max-w-[1240px] gap-3.5"
        style={{ gridTemplateColumns: "340px 1fr" }}
      >
        <Card title="Entity types" tag={`${c.entities} vertices`}>
          <Donut types={data.entityTypes} />
        </Card>
        <Card title="Storage schema" tag="context.db">
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))" }}
          >
            {SCHEMA.map(([nm, sub, cols]) => (
              <div
                key={nm}
                className="overflow-hidden rounded-[11px] border border-line bg-panel-2"
              >
                <div className="flex items-center justify-between border-b border-line px-3 py-[9px] font-mono text-[12px] font-semibold">
                  {nm}
                  <span className="text-[11px] font-normal text-muted">{sub}</span>
                </div>
                {cols.map(([cn, ct, k]) => (
                  <div
                    key={cn}
                    className={`flex justify-between border-b border-line/50 px-3 py-1.5 font-mono text-[11.5px] last:border-b-0 ${
                      k ? "text-accent" : "text-muted"
                    }`}
                  >
                    <span>{cn}</span>
                    <span className="text-[10.5px] text-faint">{ct}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
