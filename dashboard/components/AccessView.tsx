"use client";
import React from "react";
import type { GraphData } from "@/lib/types";
import { Card, Bars, SectionHead } from "./ui";

const PATHS: [string, string][] = [
  ["principals", "user + every group/role/org/team they belong to"],
  ["directRecords", "records permissioned to any principal"],
  ["recordGroups", "groups permissioned to any principal"],
  ["inheritedRecords", "recursive descent over inheritPermissions"],
  ["kbRecords", "records belonging to those groups (origin=UPLOAD)"],
  ["anyoneRecords", "org-wide shared records"],
  ["+ app scope", "connectorId filter on the corpus"],
  ["leak guard", "virtualRecordId → the ONE record you may see"],
];

function Flow({ x1, x2, y, c }: { x1: number; x2: number; y: number; c: string }) {
  return (
    <>
      <line x1={x1} y1={y} x2={x2} y2={y} stroke={c} strokeOpacity={0.3} strokeWidth={1.5} />
      <circle r={3.5} fill={c}>
        <animateMotion dur="2.2s" repeatCount="indefinite" path={`M${x1},${y} L${x2},${y}`} />
        <animate attributeName="opacity" values="0;1;1;0" dur="2.2s" repeatCount="indefinite" />
      </circle>
    </>
  );
}

export function AccessView({ data }: { data: GraphData }) {
  const W = 1080,
    H = 300,
    mid = H / 2;
  const lanes: [string, number, string, number][] = [
    ["org", data.orgs.length, "#f0abfc", 60],
    ["user / principals", data.users.length, "#7c9cff", 300],
    ["permission edges", data.permissions.length, "#5eead4", 560],
    ["accessible records", data.records.length, "#fbbf77", 840],
  ];

  const grantRows: [string, number][] = data.records
    .map((r) => [r.name || r.id, data.permissions.filter((p) => p.record === r.id).length] as [string, number])
    .filter((x) => x[1] > 0);
  const grants = grantRows.length
    ? grantRows
    : data.records.map((r) => [r.name || r.id, 1] as [string, number]);

  return (
    <div className="scrollbar absolute inset-0 overflow-auto p-[22px]">
      <SectionHead
        title="Access control"
        sub="one shared graph · each principal sees only what their ACL permits"
      />
      <div className="mx-auto mb-1.5 max-w-[1240px]">
        <Card title="Permission resolution" tag="getAccessibleVirtualRecordIds()">
          <div className="w-full overflow-auto">
            <svg viewBox={`0 0 ${W} ${H}`} width={W} className="mx-auto block max-w-full">
              <Flow x1={150} x2={300} y={mid} c="#7c9cff" />
              <Flow x1={420} x2={560} y={mid} c="#5eead4" />
              <Flow x1={650} x2={840} y={mid} c="#fbbf77" />
              {lanes.map(([nm, n, c, x]) => (
                <g key={nm}>
                  <rect
                    x={x - 58}
                    y={mid - 46}
                    width={116}
                    height={92}
                    rx={14}
                    fill="#0e1014"
                    stroke={c}
                    strokeOpacity={0.5}
                  />
                  <text
                    x={x}
                    y={mid - 8}
                    textAnchor="middle"
                    fontFamily="var(--font-mono)"
                    fontSize={30}
                    fontWeight={600}
                    fill="#e8eaf0"
                  >
                    {n}
                  </text>
                  <text x={x} y={mid + 16} textAnchor="middle" fontSize={11} fill="#878d9a">
                    {nm}
                  </text>
                  <circle cx={x} cy={mid - 46} r={3} fill={c} />
                </g>
              ))}
              <text x={430} y={56} textAnchor="middle" fontSize={11} fill="#5a6070">
                union of 8 ACL paths · dedupe first-writer-wins
              </text>
              <text x={840} y={56} textAnchor="middle" fontSize={11} fill="#5a6070">
                vector search restricted to this set →
              </text>
            </svg>
          </div>
        </Card>
      </div>

      <div className="mx-auto grid max-w-[1240px] grid-cols-2 gap-3.5">
        <Card title="Live grants" tag="permissions edges">
          <Bars rows={grants.slice(0, 11)} warm />
        </Card>
        <Card title="The eight access paths" tag="AQL → SQL, same invariant">
          <div>
            {PATHS.map((p, i) => (
              <div
                key={p[0]}
                className="flex gap-[11px] border-b border-line py-[7px] last:border-b-0"
              >
                <span className="w-[18px] font-mono text-[11px] text-accent">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <div className="font-mono text-[12px] text-ink">{p[0]}</div>
                  <div className="text-[11px] text-muted">{p[1]}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
