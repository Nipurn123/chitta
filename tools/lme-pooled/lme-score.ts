// Scores every method's jsonl against session-level gold. Abstention questions excluded.
// usage: bun run lme-score.ts <a.jsonl> [b.jsonl ...]
const qs = (await Bun.file(`${import.meta.dir}/lme-questions.json`).json()) as Array<{ id: string; type: string; abs: boolean; gold: string[] }>
const byId = new Map(qs.map((q) => [q.id, q]))
const rows: any[] = []
for (const f of process.argv.slice(2)) for (const l of (await Bun.file(f).text()).split("\n")) if (l) rows.push(JSON.parse(l))
const cats = ["ALL", "single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "temporal-reasoning", "knowledge-update"]
const methods = [...new Set(rows.map((r) => r.method))]
type Acc = { n: number; r5: number; r10: number; all10: number; any10: number; mrr: number; ms: number[]; tok: number[]; distinct: number }
const acc = new Map<string, Acc>()
const get = (k: string) => acc.get(k) ?? acc.set(k, { n: 0, r5: 0, r10: 0, all10: 0, any10: 0, mrr: 0, ms: [], tok: [], distinct: 0 }).get(k)!
for (const r of rows) {
  const q = byId.get(r.id)!
  if (q.abs) continue
  const gold = new Set(q.gold)
  const hit = (k: number) => q.gold.filter((g) => r.ranked.slice(0, k).includes(g)).length
  const first = r.ranked.findIndex((x: string) => gold.has(x))
  for (const c of ["ALL", q.type]) {
    const a = get(`${r.method}|${c}`)
    a.n++; a.r5 += hit(5) / gold.size; a.r10 += hit(10) / gold.size
    a.all10 += hit(10) === gold.size ? 1 : 0; a.any10 += hit(10) > 0 ? 1 : 0
    a.mrr += first >= 0 ? 1 / (first + 1) : 0
    a.ms.push(r.ms); if (r.tokens != null) a.tok.push(r.tokens); a.distinct += r.ranked.length
  }
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const f = (x: number) => x.toFixed(3)
console.log("method".padEnd(16), "n".padStart(4), "R@5".padStart(6), "R@10".padStart(6), "All@10".padStart(7), "Any@10".padStart(7), "MRR@10".padStart(7), "p50ms".padStart(7), "p95ms".padStart(7), "recs".padStart(5), "tok".padStart(5))
for (const c of cats) {
  console.log(`\n-- ${c}`)
  for (const m of methods) {
    const a = acc.get(`${m}|${c}`); if (!a) continue
    console.log(m.padEnd(16), String(a.n).padStart(4), f(a.r5 / a.n).padStart(6), f(a.r10 / a.n).padStart(6), f(a.all10 / a.n).padStart(7), f(a.any10 / a.n).padStart(7), f(a.mrr / a.n).padStart(7),
      pct(a.ms, 0.5).toFixed(1).padStart(7), pct(a.ms, 0.95).toFixed(1).padStart(7), (a.distinct / a.n).toFixed(1).padStart(5), a.tok.length ? String(Math.round(a.tok.reduce((x, y) => x + y, 0) / a.tok.length)).padStart(5) : "    -")
  }
}
