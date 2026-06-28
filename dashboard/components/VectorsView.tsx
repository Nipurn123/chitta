"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { GraphData, VChunk } from "@/lib/types";
import { Card, SectionHead } from "./ui";

// distinct categorical palette for source records
const PALETTE = [
  "#7c9cff", "#5eead4", "#f0abfc", "#fbbf77", "#fca5a5", "#86efac",
  "#a5b4fc", "#67e8f9", "#fcd34d", "#f9a8d4", "#93c5fd", "#6ee7b7",
];
const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function VectorsView({ data }: { data: GraphData }) {
  const V = data.vectors;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState<2 | 3>(2);
  const [sel, setSel] = useState<number | null>(null);

  // record → color
  const recColor = useMemo(() => {
    const recs = [...new Set(V.chunks.map((c) => c.record))];
    const m = new Map<string, string>();
    recs.forEach((r, i) => m.set(r, PALETTE[i % PALETTE.length]));
    return m;
  }, [V.chunks]);

  const dimRef = useRef(dim);
  const selRef = useRef<number | null>(sel);
  useEffect(() => {
    dimRef.current = dim;
  }, [dim]);
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  useEffect(() => {
    const cv = canvasRef.current!;
    const ctx = cv.getContext("2d")!;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    let W = 0,
      H = 0,
      raf = 0,
      angle = 0;
    let hover: number | null = null;
    const P: { x: number; y: number; r: number }[] = [];

    const pts = V.chunks;
    // bounds
    const ax = pts.map((p) => p.x),
      ay = pts.map((p) => p.y),
      az = pts.map((p) => p.z);
    const span = Math.max(
      Math.max(...ax) - Math.min(...ax),
      Math.max(...ay) - Math.min(...ay),
      Math.max(...az) - Math.min(...az),
      1e-3,
    );
    const cx0 = (Math.max(...ax) + Math.min(...ax)) / 2;
    const cy0 = (Math.max(...ay) + Math.min(...ay)) / 2;
    const cz0 = (Math.max(...az) + Math.min(...az)) / 2;

    function resize() {
      const r = cv.getBoundingClientRect();
      W = r.width;
      H = r.height;
      cv.width = W * DPR;
      cv.height = H * DPR;
    }

    function project(p: VChunk) {
      const pad = 46;
      const s = (Math.min(W, H) - pad * 2) / span;
      let x = p.x - cx0,
        y = p.y - cy0,
        z = p.z - cz0;
      if (dimRef.current === 3) {
        const c = Math.cos(angle),
          sn = Math.sin(angle);
        const x1 = x * c - z * sn,
          z1 = x * sn + z * c;
        const tilt = -0.32;
        const y1 = y * Math.cos(tilt) - z1 * Math.sin(tilt),
          z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt);
        const focal = span * 2.4,
          scale = focal / (focal + z2);
        return {
          sx: W / 2 + x1 * s * scale,
          sy: H / 2 + y1 * s * scale,
          depth: z2,
          scale,
        };
      }
      return { sx: W / 2 + x * s, sy: H / 2 + y * s, depth: 0, scale: 1 };
    }

    function draw() {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      P.length = 0;
      const proj = pts.map(project);
      const order =
        dimRef.current === 3
          ? pts.map((_, i) => i).sort((a, b) => proj[b].depth - proj[a].depth)
          : pts.map((_, i) => i);
      const s = selRef.current;

      // kNN links for selection
      if (s != null) {
        const a = proj[s];
        for (const nb of V.knn[s]) {
          const b = proj[nb.j];
          ctx.strokeStyle = hexA("#7c9cff", 0.15 + nb.s * 0.5);
          ctx.lineWidth = 0.5 + nb.s * 2;
          ctx.beginPath();
          ctx.moveTo(a.sx, a.sy);
          ctx.lineTo(b.sx, b.sy);
          ctx.stroke();
        }
      }

      for (const i of order) {
        const p = proj[i];
        const col = recColor.get(pts[i].record) || "#9aa3b2";
        const isSel = i === s;
        const isNbr =
          s != null && V.knn[s].some((n) => n.j === i);
        let r = (isSel ? 7 : 5) * (dimRef.current === 3 ? p.scale : 1);
        let a =
          dimRef.current === 3
            ? 0.45 + 0.55 * Math.max(0, Math.min(1, (p.depth + span) / (2 * span)))
            : 1;
        if (s != null && !isSel && !isNbr) a *= 0.35;
        P[i] = { x: p.sx, y: p.sy, r: r + 4 };

        if (isSel || i === hover || isNbr) {
          const g = ctx.createRadialGradient(p.sx, p.sy, r, p.sx, p.sy, r + 10);
          g.addColorStop(0, hexA(col, 0.5));
          g.addColorStop(1, hexA(col, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, r + 10, 0, 7);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r, 0, 7);
        ctx.fillStyle = hexA(col, a);
        ctx.fill();
        if (isSel) {
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "#fff";
          ctx.stroke();
        }
      }
    }

    function loop() {
      if (dimRef.current === 3) angle += 0.003;
      draw();
      raf = requestAnimationFrame(loop);
    }

    function pick(mx: number, my: number) {
      let best: number | null = null,
        bd = 1e9;
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        if (!p) continue;
        const d = (mx - p.x) ** 2 + (my - p.y) ** 2;
        if (d < p.r * p.r && d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    }

    const onMove = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      const i = pick(e.clientX - r.left, e.clientY - r.top);
      hover = i;
      cv.style.cursor = i != null ? "pointer" : "default";
      const tip = tipRef.current!;
      if (i != null) {
        const c = pts[i];
        tip.style.display = "block";
        tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 280) + "px";
        tip.style.top = e.clientY + 14 + "px";
        tip.innerHTML = `<div style="display:flex;align-items:center;gap:7px;font-weight:600;font-size:12px;margin-bottom:3px"><span style="width:8px;height:8px;border-radius:2px;background:${
          recColor.get(c.record) || "#9aa3b2"
        }"></span>${esc(c.record)}</div><div style="font-family:var(--font-mono);font-size:10.5px;color:var(--muted);margin-bottom:5px">${esc(
          c.id,
        )}</div><div style="font-size:11px;color:var(--ink);line-height:1.4">${esc(
          c.preview,
        )}…</div>`;
      } else tip.style.display = "none";
    };
    const onClick = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      const i = pick(e.clientX - r.left, e.clientY - r.top);
      setSel((s) => (s === i ? null : i));
    };
    const onLeave = () => {
      hover = null;
      tipRef.current!.style.display = "none";
    };

    cv.addEventListener("mousemove", onMove);
    cv.addEventListener("click", onClick);
    cv.addEventListener("mouseleave", onLeave);
    window.addEventListener("resize", resize);
    resize();
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      cv.removeEventListener("mousemove", onMove);
      cv.removeEventListener("click", onClick);
      cv.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("resize", resize);
    };
  }, [V, recColor]);

  const esc = (s: string) =>
    ("" + s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

  const selChunk = sel != null ? V.chunks[sel] : null;
  const recs = [...recColor.entries()];

  return (
    <div className="scrollbar absolute inset-0 overflow-auto p-[22px]">
      <SectionHead
        title="Vector store"
        sub={`${V.count} embedded chunks · ${V.dim}-dim · ${V.ann} · PCA projection of the real vector space`}
      />

      <div
        className="mx-auto grid max-w-[1240px] gap-3.5"
        style={{ gridTemplateColumns: "1fr 300px" }}
      >
        {/* scatter */}
        <Card title="Embedding space" tag={`PCA · ${V.dim}D → ${dim}D`}>
          <div className="relative">
            <div className="absolute right-0 top-0 z-10 flex overflow-hidden rounded-lg border border-line-2">
              {([2, 3] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDim(d)}
                  className={`px-3 py-1 text-[11.5px] transition-colors ${
                    dim === d ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {d === 2 ? "2D" : "3D · rotating"}
                </button>
              ))}
            </div>
            <canvas ref={canvasRef} className="block h-[440px] w-full" />
            <p className="absolute bottom-1 left-0 text-[11px] text-faint">
              each point = one chunk vector · proximity ≈ semantic similarity · click to see
              nearest neighbors
            </p>
          </div>
        </Card>

        {/* right rail */}
        <div className="flex flex-col gap-3.5">
          <Card title="Index" tag="vector store">
            <Row k="dimensions" v={V.dim} />
            <Row k="vectors" v={V.count} />
            <Row k="index" v={V.vecEnabled ? "vec0 ANN" : "cosine"} />
            <Row k="metric" v="cosine" />
            <Row k="source" v={`${recs.length} records`} last />
          </Card>

          <Card title="Variance explained" tag="top components">
            <div className="flex flex-col gap-2">
              {V.explained.slice(0, 3).map((e, i) => (
                <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: "34px 1fr 42px" }}>
                  <span className="font-mono text-[11px] text-muted">PC{i + 1}</span>
                  <div className="h-2 overflow-hidden rounded-[5px] bg-panel-2">
                    <div
                      className="animate-grow h-full rounded-[5px]"
                      style={{
                        width: `${Math.min(100, e * 100 * 3)}%`,
                        background: "linear-gradient(90deg,#5eead4,#7c9cff)",
                        animationDelay: `${i * 60}ms`,
                      }}
                    />
                  </div>
                  <span className="text-right font-mono text-[11px] text-ink">
                    {(e * 100).toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card title={selChunk ? "Nearest neighbors" : "Inspect"} tag={selChunk ? "cosine" : "click a point"}>
            {selChunk ? (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 flex-none rounded-[3px]"
                    style={{ background: recColor.get(selChunk.record) }}
                  />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-semibold">
                    {selChunk.record}
                  </span>
                </div>
                <div className="mb-3 text-[11px] leading-[1.5] text-muted">
                  {selChunk.preview}…
                </div>
                {V.knn[sel!].map((nb) => {
                  const c = V.chunks[nb.j];
                  return (
                    <div
                      key={nb.j}
                      onClick={() => setSel(nb.j)}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-panel-2"
                    >
                      <span
                        className="h-2 w-2 flex-none rounded-sm"
                        style={{ background: recColor.get(c.record) }}
                      />
                      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-muted">
                        {c.record}
                      </span>
                      <span className="font-mono text-[11px] text-[var(--good)]">
                        {nb.s.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </>
            ) : (
              <div className="text-[11.5px] leading-[1.6] text-faint">
                Click any point in the embedding space to see its top-5 nearest chunks by cosine
                similarity - the same ranking the retriever walks.
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* similarity heatmap */}
      <div className="mx-auto mt-3.5 max-w-[1240px]">
        <Card title="Cosine similarity matrix" tag={`${V.count} × ${V.count} chunks`}>
          <Heatmap V={V} recColor={recColor} sel={sel} onSel={setSel} />
        </Card>
      </div>

      <div
        ref={tipRef}
        className="pointer-events-none absolute z-[5] hidden max-w-[260px] rounded-[9px] border border-line-2 px-[11px] py-[9px]"
        style={{ background: "rgba(8,9,11,.94)", boxShadow: "0 8px 30px rgba(0,0,0,.5)" }}
      />
    </div>
  );
}

function Row({ k, v, last }: { k: string; v: string | number; last?: boolean }) {
  return (
    <div
      className={`flex justify-between py-[5px] font-mono text-[12px] ${
        last ? "" : "border-b border-line/60"
      }`}
    >
      <span className="text-muted">{k}</span>
      <span className="text-ink">{v}</span>
    </div>
  );
}

function Heatmap({
  V,
  recColor,
  sel,
  onSel,
}: {
  V: GraphData["vectors"];
  recColor: Map<string, string>;
  sel: number | null;
  onSel: (i: number | null) => void;
}) {
  const n = V.count;
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const cell = Math.max(8, Math.min(20, Math.floor(560 / n)));
  const size = n * cell;
  const color = (s: number) => {
    // 0 → panel, 1 → accent; emphasize high similarity
    const t = Math.max(0, Math.min(1, s));
    const r = Math.round(18 + t * (124 - 18));
    const g = Math.round(20 + t * (156 - 20));
    const b = Math.round(25 + t * (255 - 25));
    return `rgb(${r},${g},${b})`;
  };
  return (
    <div className="flex items-start gap-4">
      <div className="overflow-auto">
        <svg width={size} height={size} className="block">
          {V.sim.map((row, i) =>
            row.map((s, j) => {
              const on =
                sel == null ||
                sel === i ||
                sel === j ||
                V.knn[sel].some((k) => k.j === i || k.j === j);
              return (
                <rect
                  key={`${i}-${j}`}
                  x={j * cell}
                  y={i * cell}
                  width={cell - 1}
                  height={cell - 1}
                  rx={1.5}
                  fill={color(s)}
                  opacity={i === j ? 0.25 : on ? 1 : 0.18}
                  onMouseEnter={() => setHover({ i, j })}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onSel(sel === i ? null : i)}
                  style={{ cursor: "pointer" }}
                />
              );
            }),
          )}
        </svg>
      </div>
      <div className="flex flex-col gap-2 pt-1 text-[11.5px] text-muted">
        <div className="text-faint">
          row = chunk · cell = cosine(rowᵢ, colⱼ) · brighter = closer
        </div>
        {hover && (
          <div className="rounded-lg border border-line bg-panel-2 p-2.5 font-mono text-[11px]">
            <div className="mb-1 text-[var(--good)]">
              cosine = {V.sim[hover.i][hover.j].toFixed(3)}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: recColor.get(V.chunks[hover.i].record) }} />
              <span className="text-ink">{V.chunks[hover.i].record}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: recColor.get(V.chunks[hover.j].record) }} />
              <span className="text-muted">{V.chunks[hover.j].record}</span>
            </div>
          </div>
        )}
        <div className="mt-1 flex items-center gap-2">
          <span className="text-faint">0</span>
          <div
            className="h-2 w-24 rounded"
            style={{ background: "linear-gradient(90deg,#121419,#7c9cff)" }}
          />
          <span className="text-faint">1</span>
        </div>
      </div>
    </div>
  );
}
