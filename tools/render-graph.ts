// Render Chitta's REAL knowledge graph to SVG frames (with entity labels), matching the
// dashboard look. SVG -> PNG via rsvg-convert -> ffmpeg (done outside). No browser.
import { writeFileSync, mkdirSync } from "node:fs";

const REPO = "/Users/nipurnagarwal/Desktop/100XContext/context-mcp";
const OUT = process.argv[2] || "/private/tmp/svg";
const FRAMES = Number(process.argv[3] || 96);
mkdirSync(OUT, { recursive: true });
const W = 1280, H = 800;

const g = JSON.parse(await Bun.file(`${REPO}/dashboard/data/graph.json`).text());
type N = { id: string; label: string; type: string; degree: number; x: number; y: number; z: number; vx: number; vy: number; vz: number };
const byId = new Map<string, N>();
let rng = 987654321;
const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (const e of g.entities) {
  if ((e.degree ?? 0) < 1) continue;
  byId.set(e.id, { id: e.id, label: e.label, type: e.type, degree: e.degree,
    x: (rand() - 0.5) * 300, y: (rand() - 0.5) * 300, z: (rand() - 0.5) * 300, vx: 0, vy: 0, vz: 0 });
}
const nodes = [...byId.values()];
const idxOf = new Map<N, number>(nodes.map((n, i) => [n, i]));
const edges = g.relations.filter((r: any) => byId.has(r.from) && byId.has(r.to))
  .map((r: any) => ({ a: byId.get(r.from)!, b: byId.get(r.to)! }));
console.log(`nodes ${nodes.length}, edges ${edges.length}`);

// force layout
for (let it = 0; it < 240; it++) {
  for (let i = 0; i < nodes.length; i++) { const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) { const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; let d2 = dx*dx+dy*dy+dz*dz+0.01;
      const f = 1500 / d2, d = Math.sqrt(d2); dx/=d; dy/=d; dz/=d;
      a.vx+=dx*f; a.vy+=dy*f; a.vz+=dz*f; b.vx-=dx*f; b.vy-=dy*f; b.vz-=dz*f; } }
  for (const { a, b } of edges) { let dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z;
    const d=Math.sqrt(dx*dx+dy*dy+dz*dz)+0.01, f=(d-46)*0.02; dx/=d; dy/=d; dz/=d;
    a.vx+=dx*f; a.vy+=dy*f; a.vz+=dz*f; b.vx-=dx*f; b.vy-=dy*f; b.vz-=dz*f; }
  for (const n of nodes) { n.vx-=n.x*0.002; n.vy-=n.y*0.002; n.vz-=n.z*0.002;
    n.x+=n.vx*0.85; n.y+=n.vy*0.85; n.z+=n.vz*0.85; n.vx*=0.82; n.vy*=0.82; n.vz*=0.82; } }
let maxr = 1; for (const n of nodes) maxr = Math.max(maxr, Math.hypot(n.x, n.y, n.z));
const sc = 250 / maxr; for (const n of nodes) { n.x*=sc; n.y*=sc; n.z*=sc; }

// dashboard palette
const PAL: Record<string, string> = {
  CONCEPT: "#5b8cff", ORG: "#c084fc", ACRONYM: "#2dd4bf", PRODUCT: "#f59e0b",
  PERSON: "#fb7185", PLACE: "#9aa6b8", ENTITY: "#cbd5e1", ACTIVITY: "#34d399",
};
const col = (t: string) => PAL[t] ?? "#8aa0c0";

// label the top hubs by degree
const LABELN = 18;
const labelIds = new Set([...nodes].sort((a, b) => b.degree - a.degree).slice(0, LABELN).map(n => n.id));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cx = W / 2, cy = H / 2, focal = 980, camZ = 760, tilt = 0.4, ct = Math.cos(tilt), st = Math.sin(tilt);

const defs = `<defs>
<radialGradient id="bg" cx="50%" cy="46%" r="75%">
  <stop offset="0%" stop-color="#0c1120"/><stop offset="60%" stop-color="#070a14"/><stop offset="100%" stop-color="#04050b"/>
</radialGradient>
${Object.entries(PAL).map(([t, c]) => `<radialGradient id="g-${t}" cx="50%" cy="50%" r="50%">
  <stop offset="0%" stop-color="${c}" stop-opacity="0.95"/><stop offset="35%" stop-color="${c}" stop-opacity="0.45"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/>
</radialGradient>`).join("\n")}
</defs>`;

for (let f = 0; f < FRAMES; f++) {
  const ang = (f / FRAMES) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
  const P = nodes.map(n => {
    let x = n.x*ca - n.z*sa, z = n.x*sa + n.z*ca, y = n.y;
    const y2 = y*ct - z*st, z2 = y*st + z*ct; y = y2; z = z2;
    const s = focal / (camZ - z);
    return { sx: cx + x*s, sy: cy - y*s, depth: z, s };
  });
  const order = P.map((_, i) => i).sort((i, j) => P[i].depth - P[j].depth);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}`;
  svg += `<rect width="${W}" height="${H}" fill="url(#bg)"/>`;
  // edges
  let e = "";
  for (const { a, b } of edges) {
    const pa = P[idxOf.get(a)!], pb = P[idxOf.get(b)!];
    const op = (0.06 + 0.16 * Math.max(0, Math.min(1, (pa.depth + pb.depth) / 2 + 250) / 500)).toFixed(3);
    e += `<line x1="${pa.sx.toFixed(1)}" y1="${pa.sy.toFixed(1)}" x2="${pb.sx.toFixed(1)}" y2="${pb.sy.toFixed(1)}" stroke="#5e7196" stroke-opacity="${op}" stroke-width="0.7"/>`;
  }
  svg += `<g>${e}</g>`;
  // nodes back-to-front
  let circles = "", labels = "";
  for (const idx of order) {
    const p = P[idx], n = nodes[idx]; if (p.s <= 0) continue;
    const fade = Math.max(0.35, Math.min(1.1, (p.depth + 260) / 380));
    const r = Math.max(2.4, Math.min(30, (3 + Math.sqrt(n.degree) * 2.3) * p.s));
    const c = col(n.type);
    circles += `<circle cx="${p.sx.toFixed(1)}" cy="${p.sy.toFixed(1)}" r="${(r*2.6).toFixed(1)}" fill="url(#g-${n.type in PAL ? n.type : "CONCEPT"})" opacity="${(0.55*fade).toFixed(2)}"/>`;
    circles += `<circle cx="${p.sx.toFixed(1)}" cy="${p.sy.toFixed(1)}" r="${r.toFixed(1)}" fill="${c}" opacity="${(0.95*fade).toFixed(2)}"/>`;
    circles += `<circle cx="${(p.sx - r*0.3).toFixed(1)}" cy="${(p.sy - r*0.3).toFixed(1)}" r="${(r*0.4).toFixed(1)}" fill="#ffffff" opacity="${(0.5*fade).toFixed(2)}"/>`;
    if (labelIds.has(n.id) && p.depth > 10) {
      const lx = (p.sx + r + 5).toFixed(1), ly = (p.sy + 5).toFixed(1);
      const lop = Math.max(0.5, fade).toFixed(2);
      labels += `<text x="${lx}" y="${ly}" font-family="Helvetica,Arial,sans-serif" font-size="15.5" font-weight="600" fill="#eef3ff" fill-opacity="${lop}" style="paint-order:stroke" stroke="#04050b" stroke-width="3" stroke-opacity="0.9">${esc(n.label)}</text>`;
    }
  }
  svg += `<g>${circles}</g><g>${labels}</g>`;
  // title overlay
  svg += `<text x="40" y="56" font-family="Helvetica,Arial,sans-serif" font-size="26" font-weight="700" fill="#ffffff" fill-opacity="0.96">Chitta</text>`;
  svg += `<text x="40" y="80" font-family="Helvetica,Arial,sans-serif" font-size="14" fill="#9fb0cc">permission-aware memory for AI agents · ${nodes.length} concepts · ${edges.length} links</text>`;
  svg += `</svg>`;
  writeFileSync(`${OUT}/f${String(f).padStart(4, "0")}.svg`, svg);
  if (f % 24 === 0) console.log(`frame ${f}/${FRAMES}`);
}
console.log("done svg →", OUT);
