// Head-to-head: per question, did method A or B get ALL gold sessions into its top-10?
// usage: bun run lme-diff.ts <methodA> <methodB> <files...>
const [A, B, ...files] = process.argv.slice(2)
const qs = (await Bun.file(`${import.meta.dir}/lme-questions.json`).json()) as Array<{ id: string; type: string; abs: boolean; question: string; answer: string; gold: string[] }>
const res = new Map<string, string[]>()
for (const f of files) for (const l of (await Bun.file(f).text()).split("\n")) if (l) { const r = JSON.parse(l); res.set(`${r.method}|${r.id}`, r.ranked) }
const full = (m: string, q: (typeof qs)[number]) => q.gold.every((g) => (res.get(`${m}|${q.id}`) ?? []).includes(g))
const aOnly: typeof qs = [], bOnly: typeof qs = []
let both = 0, neither = 0
for (const q of qs) {
  if (q.abs) continue
  const a = full(A, q), b = full(B, q)
  if (a && b) both++; else if (a) aOnly.push(q); else if (b) bOnly.push(q); else neither++
}
console.log(`all-gold-in-top-10: both=${both}  only ${A}=${aOnly.length}  only ${B}=${bOnly.length}  neither=${neither}`)
const byType = (xs: typeof qs) => Object.entries(xs.reduce((m: Record<string, number>, q) => ((m[q.type] = (m[q.type] ?? 0) + 1), m), {})).map(([k, v]) => `${k}:${v}`).join(" ")
console.log(`only ${A} by type: ${byType(aOnly)}`)
console.log(`only ${B} by type: ${byType(bOnly)}`)
for (const [label, xs] of [[`${B} wins`, bOnly], [`${A} wins`, aOnly]] as const) {
  console.log(`\n${label} (examples):`)
  for (const q of xs.slice(0, 5)) console.log(`  [${q.type}] ${q.question}  → ${q.answer.slice(0, 60)}`)
}
