"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { GraphData } from "@/lib/types";
import { typeColor } from "@/lib/types";

type Kind = "entity" | "record";
interface N {
  id: string;
  label: string;
  type: string;
  degree: number;
  kind: Kind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}
interface L {
  s: string;
  t: string;
  type: string;
  kind: "rel" | "mem";
}

interface SimState {
  dim: 2 | 3;
  layers: { relations: boolean; records: boolean };
  hidden: Set<string>;
  query: string;
  focus: string | null;
  zoom: number;
  panX: number;
  panY: number;
  angleY: number;
  angleX: number;
  hover: string | null;
}

const hexA = (hex: string, a: number) => {
  if (hex[0] !== "#") return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function GraphView({ data }: { data: GraphData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // ── UI state (drives the control panel + detail card) ──
  const [dim, setDim] = useState<2 | 3>(2);
  const [layers, setLayers] = useState({ relations: true, records: false });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [focusNode, setFocusNode] = useState<N | null>(null);

  // ── stable model (built once) ──
  const model = useMemo(() => {
    const ent: N[] = data.entities.map((e) => ({
      id: e.id,
      label: e.label,
      type: e.type,
      degree: e.degree || 0,
      kind: "entity" as Kind,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    }));
    const rec: N[] = data.records.map((r) => ({
      id: r.id,
      label: r.name || r.id,
      type: "RECORD",
      degree: r.mentions || 0,
      kind: "record" as Kind,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    }));
    const all = [...ent, ...rec];
    all.forEach((n, i) => {
      const a = i * 2.399963,
        r = 18 * Math.sqrt(i);
      n.x = Math.cos(a) * r;
      n.y = Math.sin(a) * r;
      n.z = (Math.random() - 0.5) * r * 1.4;
    });
    const map = new Map<string, N>();
    all.forEach((n) => map.set(n.id, n));
    const relLinks: L[] = data.relations
      .filter((r) => map.has(r.from) && map.has(r.to))
      .map((r) => ({ s: r.from, t: r.to, type: r.type, kind: "rel" }));
    const memLinks: L[] = data.mentions
      .filter((m) => map.has(m.record) && map.has(m.entity))
      .map((m) => ({ s: m.record, t: m.entity, type: "mentions", kind: "mem" }));
    const adj = new Map<string, { id: string; pred: string }[]>();
    const add = (a: string, b: string, p: string) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a)!.push({ id: b, pred: p });
    };
    relLinks.forEach((l) => {
      add(l.s, l.t, l.type);
      add(l.t, l.s, l.type);
    });
    memLinks.forEach((l) => {
      add(l.s, l.t, "mentions");
      add(l.t, l.s, "mentioned in");
    });
    return { all, map, relLinks, memLinks, adj };
  }, [data]);

  // ── shared mutable sim state (read by the render loop) ──
  const stateRef = useRef<SimState>({
    dim: 2,
    layers: { relations: true, records: false },
    hidden: new Set(),
    query: "",
    focus: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    angleY: 0,
    angleX: -0.35,
    hover: null,
  });
  // keep simState in sync with React controls
  useEffect(() => {
    const s = stateRef.current;
    const reheatNeeded =
      s.dim !== dim ||
      s.layers.relations !== layers.relations ||
      s.layers.records !== layers.records ||
      s.hidden.size !== hidden.size;
    s.dim = dim;
    s.layers = layers;
    s.hidden = hidden;
    s.query = query.trim().toLowerCase();
    s.focus = focusNode?.id ?? null;
    if (reheatNeeded) alphaRef.current = Math.max(alphaRef.current, 0.9);
  }, [dim, layers, hidden, query, focusNode]);

  const alphaRef = useRef(1);
  const PRef = useRef<Map<string, { sx: number; sy: number; depth: number; scale: number }>>(
    new Map(),
  );

  // ── main effect: simulation + render + interaction ──
  useEffect(() => {
    const cv = canvasRef.current!;
    const ctx = cv.getContext("2d")!;
    const { all, map, relLinks, memLinks, adj } = model;
    const S = stateRef.current;
    let DPR = Math.min(2, window.devicePixelRatio || 1);
    let W = 0,
      H = 0;
    let raf = 0;

    const activeNodes = () =>
      all.filter((n) =>
        n.kind === "record" ? S.layers.records : !S.hidden.has(n.type),
      );
    const activeLinks = () => {
      const vis = new Set(activeNodes().map((n) => n.id));
      let Ls: L[] = [];
      if (S.layers.relations) Ls = Ls.concat(relLinks);
      if (S.layers.records) Ls = Ls.concat(memLinks);
      return Ls.filter((l) => vis.has(l.s) && vis.has(l.t));
    };

    const drag = { node: null as N | null, moved: false };
    const pan = { on: false };

    function tick() {
      if (alphaRef.current < 0.005) return;
      const a3 = S.dim === 3;
      const N = activeNodes();
      const Ls = activeLinks();
      const alpha = alphaRef.current;
      const k = a3 ? 42 : 54;
      for (let i = 0; i < N.length; i++) {
        const a = N[i];
        for (let j = i + 1; j < N.length; j++) {
          const b = N[j];
          let dx = a.x - b.x,
            dy = a.y - b.y,
            dz = a3 ? a.z - b.z : 0;
          const d2 = dx * dx + dy * dy + dz * dz + 0.01;
          const d = Math.sqrt(d2);
          const f = ((k * k) / d2) * alpha;
          dx /= d;
          dy /= d;
          dz /= d;
          a.vx += dx * f;
          a.vy += dy * f;
          a.vz += dz * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
          b.vz -= dz * f;
        }
      }
      for (const l of Ls) {
        const a = map.get(l.s)!,
          b = map.get(l.t)!;
        let dx = b.x - a.x,
          dy = b.y - a.y,
          dz = a3 ? b.z - a.z : 0;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
        const desired = l.kind === "mem" ? 70 : 60;
        const f = ((d - desired) / d) * 0.04 * alpha * (l.kind === "mem" ? 0.5 : 1);
        dx *= f;
        dy *= f;
        dz *= f;
        a.vx += dx;
        a.vy += dy;
        a.vz += dz;
        b.vx -= dx;
        b.vy -= dy;
        b.vz -= dz;
      }
      for (const n of N) {
        n.vx += -n.x * 0.0016 * alpha;
        n.vy += -n.y * 0.0016 * alpha;
        if (a3) n.vz += -n.z * 0.0016 * alpha;
        if (n === drag.node) continue;
        n.x += n.vx *= 0.82;
        n.y += n.vy *= 0.82;
        if (a3) n.z += n.vz *= 0.82;
        else {
          n.z = 0;
          n.vz = 0;
        }
      }
      alphaRef.current *= 0.985;
    }

    function project(n: N) {
      if (S.dim === 3) {
        const cy = Math.cos(S.angleY),
          sy = Math.sin(S.angleY);
        const x1 = n.x * cy - n.z * sy,
          z1 = n.x * sy + n.z * cy;
        const cx = Math.cos(S.angleX),
          sx = Math.sin(S.angleX);
        const y1 = n.y * cx - z1 * sx,
          z2 = n.y * sx + z1 * cx;
        const focal = 620,
          scale = focal / (focal + z2);
        return {
          sx: W / 2 + S.panX + x1 * scale * S.zoom,
          sy: H / 2 + S.panY + y1 * scale * S.zoom,
          depth: z2,
          scale,
        };
      }
      return {
        sx: W / 2 + S.panX + n.x * S.zoom,
        sy: H / 2 + S.panY + n.y * S.zoom,
        depth: 0,
        scale: 1,
      };
    }

    function radius(n: N, p: { scale: number }) {
      const base = n.kind === "record" ? 5.5 : 3.2;
      let r =
        (base + Math.sqrt(n.degree) * 1.5) *
        (S.dim === 3 ? p.scale : 1) *
        Math.sqrt(S.zoom);
      return Math.max(2, Math.min(r, 26));
    }

    function draw() {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const N = activeNodes();
      const Ls = activeLinks();
      const P = PRef.current;
      P.clear();
      N.forEach((n) => P.set(n.id, project(n)));
      const foc = S.focus;
      const neigh = foc
        ? new Set([foc, ...(adj.get(foc) || []).map((a) => a.id)])
        : null;

      ctx.lineWidth = 1;
      for (const l of Ls) {
        const a = P.get(l.s),
          b = P.get(l.t);
        if (!a || !b) continue;
        const on = !neigh || (neigh.has(l.s) && neigh.has(l.t));
        const typed = l.kind === "rel" && l.type !== "relates_to";
        let ae = on ? (typed ? 0.5 : 0.16) : 0.03;
        if (l.kind === "mem") ae = on ? 0.1 : 0.02;
        ctx.strokeStyle = typed
          ? `rgba(251,191,119,${ae})`
          : `rgba(140,150,175,${ae})`;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }

      const order =
        S.dim === 3
          ? N.slice().sort((x, y) => P.get(y.id)!.depth - P.get(x.id)!.depth)
          : N;
      const q = S.query;
      for (const n of order) {
        const p = P.get(n.id)!;
        const r = radius(n, p);
        const isFoc = neigh ? neigh.has(n.id) : true;
        const match = q && n.label.toLowerCase().includes(q);
        const col = n.kind === "record" ? "#cdd3e0" : typeColor(n.type);
        let a = isFoc
          ? S.dim === 3
            ? 0.55 + 0.45 * Math.max(0, Math.min(1, (p.depth + 260) / 520))
            : 1
          : 0.12;
        if (q) a = match ? 1 : a * 0.18;

        if (n.id === S.hover || n.id === foc || match) {
          const g = ctx.createRadialGradient(p.sx, p.sy, r, p.sx, p.sy, r + 9);
          g.addColorStop(0, hexA(col, 0.5));
          g.addColorStop(1, hexA(col, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.sx, p.sy, r + 9, 0, 7);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r, 0, 7);
        ctx.fillStyle = hexA(col, a);
        ctx.fill();
        if (n.kind === "record") {
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = hexA("#ffffff", a * 0.5);
          ctx.stroke();
        }
        const showLabel =
          match ||
          n.id === S.hover ||
          (neigh && neigh.has(n.id)) ||
          (!q && !foc && n.degree >= 7);
        if (showLabel && a > 0.3) {
          ctx.font = `${n.kind === "record" ? 600 : 500} ${Math.min(
            13,
            11 * Math.sqrt(S.zoom),
          )}px var(--font-sans),sans-serif`;
          ctx.fillStyle = hexA("#e8eaf0", Math.min(1, a + 0.2));
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(n.label, p.sx + r + 5, p.sy);
        }
      }
    }

    function loop() {
      if (S.dim === 3 && !drag.node) S.angleY += 0.0022;
      tick();
      draw();
      raf = requestAnimationFrame(loop);
    }

    function resize() {
      const r = cv.getBoundingClientRect();
      W = r.width;
      H = r.height;
      cv.width = W * DPR;
      cv.height = H * DPR;
    }

    function pick(mx: number, my: number): N | null {
      const P = PRef.current;
      let best: N | null = null,
        bd = 1e9;
      for (const n of activeNodes()) {
        const p = P.get(n.id);
        if (!p) continue;
        const dx = mx - p.sx,
          dy = my - p.sy,
          d = dx * dx + dy * dy;
        const r = radius(n, p) + 5;
        if (d < r * r && d < bd) {
          bd = d;
          best = n;
        }
      }
      return best;
    }

    const label = (id: string) => map.get(id)?.label ?? id;
    function showTip(n: N, x: number, y: number) {
      const tip = tipRef.current!;
      const a = adj.get(n.id) || [];
      const typed = a.filter(
        (z) =>
          z.pred !== "relates_to" &&
          z.pred !== "mentions" &&
          z.pred !== "mentioned in",
      );
      const col = n.kind === "record" ? "#cdd3e0" : typeColor(n.type);
      tip.style.display = "block";
      tip.style.left = Math.min(x + 14, window.innerWidth - 260) + "px";
      tip.style.top = y + 14 + "px";
      tip.innerHTML =
        `<div style="display:flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px;margin-bottom:4px"><span style="width:8px;height:8px;border-radius:2px;background:${col}"></span>${esc(
          n.label,
        )}</div>` +
        `<div style="font-family:var(--font-mono);font-size:11px;color:var(--muted)">${n.kind} · ${n.type} · <b style="color:var(--ink)">${n.degree}</b> links</div>` +
        (typed.length
          ? `<div style="margin-top:6px;font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding-top:6px">${typed
              .slice(0, 3)
              .map(
                (z) =>
                  `<span style="color:var(--accent)">${z.pred}</span> ${esc(
                    label(z.id),
                  )}`,
              )
              .join("<br>")}${
              typed.length > 3 ? `<br>+${typed.length - 3} more` : ""
            }</div>`
          : "");
    }

    // ── listeners ──
    const onMove = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left,
        my = e.clientY - r.top;
      if (drag.node) {
        if (S.dim === 2) {
          drag.node.x = (mx - W / 2 - S.panX) / S.zoom;
          drag.node.y = (my - H / 2 - S.panY) / S.zoom;
        } else {
          drag.node.x += e.movementX / S.zoom;
          drag.node.y += e.movementY / S.zoom;
        }
        drag.moved = true;
        alphaRef.current = Math.max(alphaRef.current, 0.5);
        return;
      }
      if (pan.on) {
        S.panX += e.movementX;
        S.panY += e.movementY;
        return;
      }
      const n = pick(mx, my);
      S.hover = n?.id ?? null;
      cv.style.cursor = n ? "pointer" : "grab";
      if (n) showTip(n, e.clientX, e.clientY);
      else tipRef.current!.style.display = "none";
    };
    const onDown = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      const n = pick(e.clientX - r.left, e.clientY - r.top);
      if (n) {
        drag.node = n;
        drag.moved = false;
      } else pan.on = true;
    };
    const onUp = () => {
      if (drag.node && !drag.moved) {
        const same = S.focus === drag.node.id;
        setFocusNode(same ? null : drag.node);
      } else if (pan.on && !drag.node) {
        // background click clears focus
        if (Math.abs(S.panX) >= 0) {
          /* keep focus unless explicit clear below */
        }
      }
      drag.node = null;
      pan.on = false;
    };
    const onLeave = () => {
      tipRef.current!.style.display = "none";
      S.hover = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.12 : 0.89;
      S.zoom = Math.max(0.15, Math.min(6, S.zoom * f));
    };
    const onClickEmpty = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      if (!pick(e.clientX - r.left, e.clientY - r.top) && !drag.moved) {
        setFocusNode(null);
      }
    };

    cv.addEventListener("mousemove", onMove);
    cv.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    cv.addEventListener("mouseleave", onLeave);
    cv.addEventListener("wheel", onWheel, { passive: false });
    cv.addEventListener("click", onClickEmpty);
    window.addEventListener("resize", resize);

    // expose zoom controls
    (cv as any).__zoom = (f: number) =>
      (S.zoom = Math.max(0.15, Math.min(6, S.zoom * f)));
    (cv as any).__reset = () => {
      S.zoom = 1;
      S.panX = 0;
      S.panY = 0;
      setFocusNode(null);
      alphaRef.current = Math.max(alphaRef.current, 0.6);
    };

    resize();
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      cv.removeEventListener("mousemove", onMove);
      cv.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      cv.removeEventListener("mouseleave", onLeave);
      cv.removeEventListener("wheel", onWheel);
      cv.removeEventListener("click", onClickEmpty);
      window.removeEventListener("resize", resize);
    };
  }, [model]);

  const esc = (s: string) =>
    ("" + s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

  const zoom = (f: number) => (canvasRef.current as any)?.__zoom?.(f);
  const reset = () => (canvasRef.current as any)?.__reset?.();

  const focusLinks = focusNode ? model.adj.get(focusNode.id) || [] : [];

  return (
    <div className="absolute inset-0">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full cursor-grab active:cursor-grabbing"
      />

      {/* control rail */}
      <div className="panel-blur pointer-events-auto absolute left-[18px] top-[18px] flex w-[230px] flex-col gap-3.5 rounded-[13px] border border-line p-3.5">
        <div className="relative">
          <svg
            className="absolute left-[9px] top-[9px] opacity-50"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search entities…"
            className="w-full rounded-lg border border-line-2 bg-bg py-2 pl-[30px] pr-2.5 text-[12.5px] text-ink outline-none focus:border-accent"
          />
        </div>

        <Group title="Projection">
          <div className="flex overflow-hidden rounded-lg border border-line-2">
            {([2, 3] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDim(d)}
                className={`flex-1 py-1.5 text-[11.5px] transition-colors ${
                  dim === d ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {d === 2 ? "2D" : "3D · rotating"}
              </button>
            ))}
          </div>
        </Group>

        <Group title="Layers">
          <div className="flex gap-1.5">
            {(["relations", "records"] as const).map((lk) => (
              <button
                key={lk}
                onClick={() => setLayers((s) => ({ ...s, [lk]: !s[lk] }))}
                className={`flex-1 rounded-[7px] border py-1.5 text-[11.5px] transition-colors ${
                  layers[lk]
                    ? "border-accent bg-accent font-semibold text-[#0a0d18]"
                    : "border-line-2 text-muted hover:text-ink"
                }`}
              >
                {lk}
              </button>
            ))}
          </div>
        </Group>

        <Group title={`Entity types · ${data.entityTypes.length}`}>
          <div className="flex flex-col gap-0.5">
            {data.entityTypes.map((t) => {
              const off = hidden.has(t.type);
              return (
                <div
                  key={t.type}
                  onClick={() =>
                    setHidden((s) => {
                      const n = new Set(s);
                      n.has(t.type) ? n.delete(t.type) : n.add(t.type);
                      return n;
                    })
                  }
                  className={`flex cursor-pointer select-none items-center gap-2.5 rounded-[7px] px-[7px] py-[5px] transition-colors hover:bg-panel-2 ${
                    off ? "opacity-30" : ""
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 flex-none rounded-[3px]"
                    style={{ background: typeColor(t.type) }}
                  />
                  <span className="flex-1 text-[12px]">{t.type.toLowerCase()}</span>
                  <span className="font-mono text-[11px] text-muted">{t.n}</span>
                </div>
              );
            })}
          </div>
        </Group>

        <p className="text-[11px] leading-[1.5] text-faint">
          drag node · scroll zoom · click to focus neighborhood · drag canvas to pan
        </p>
      </div>

      {/* hover tooltip (imperatively populated) */}
      <div
        ref={tipRef}
        className="pointer-events-none absolute z-[5] hidden max-w-[240px] rounded-[9px] border border-line-2 px-[11px] py-[9px]"
        style={{
          background: "rgba(8,9,11,.94)",
          boxShadow: "0 8px 30px rgba(0,0,0,.5)",
        }}
      />

      {/* detail card */}
      {focusNode && (
        <div className="panel-blur scrollbar pointer-events-auto absolute bottom-[18px] right-[18px] w-[268px] overflow-hidden rounded-[13px] border border-line">
          <div className="border-b border-line px-[15px] py-[13px]">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold">
              <span
                className="h-[9px] w-[9px] rounded-[3px]"
                style={{
                  background:
                    focusNode.kind === "record" ? "#cdd3e0" : typeColor(focusNode.type),
                }}
              />
              {focusNode.label}
            </h3>
            <div className="mt-[3px] font-mono text-[10.5px] text-muted">
              {focusNode.kind} · {focusNode.type} · degree {focusNode.degree}
            </div>
          </div>
          <div className="scrollbar max-h-[220px] overflow-auto px-[15px] py-[11px]">
            {focusLinks.length ? (
              focusLinks
                .slice()
                .sort(
                  (a, b) =>
                    Number(a.pred === "relates_to") - Number(b.pred === "relates_to"),
                )
                .map((z, i) => (
                  <div key={i} className="flex items-center gap-2 py-1 text-[12px]">
                    <span
                      className="whitespace-nowrap rounded-[5px] px-1.5 py-px font-mono text-[10px]"
                      style={{ background: "rgba(251,191,119,.1)", color: "var(--warn)" }}
                    >
                      {z.pred}
                    </span>
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted">
                      {model.map.get(z.id)?.label ?? z.id}
                    </span>
                  </div>
                ))
            ) : (
              <div className="text-[11px] text-faint">no relations</div>
            )}
          </div>
        </div>
      )}

      {/* zoom controls */}
      <div className="absolute bottom-[18px] left-[18px] flex gap-1.5">
        {[
          { l: "+", f: () => zoom(1.2) },
          { l: "−", f: () => zoom(0.83) },
          { l: "⤢", f: reset },
        ].map((b, i) => (
          <button
            key={i}
            onClick={b.f}
            className="panel-blur grid h-[34px] w-[34px] place-items-center rounded-[9px] border border-line text-[16px] text-muted transition-colors hover:border-line-2 hover:text-ink"
          >
            {b.l}
          </button>
        ))}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">
        {title}
      </div>
      {children}
    </div>
  );
}
