// DEEP-MEMORY BENCHMARK - the missing MEASUREMENT layer.
//
// The living-memory features (entity resolution, hybrid retrieval, contradiction
// resolution) were unit-tested for MECHANISM ("does the code path fire?") but never
// MEASURED for QUALITY ("how good is the result, as a number?"). This file closes that
// gap: it ingests synthetic-but-realistic corpora through the PUBLIC embedded API and
// emits reproducible metrics. Three axes, each with a headline number and a sane (not
// brittle) threshold so it doubles as a regression gate:
//
//   [1] ENTITY-RESOLUTION FRAGMENTATION - the same real-world entity appears under many
//       surface forms across many docs ("Sarah Chen" / "Sarah" / "Ms. Chen"; "Acme" /
//       "Acme Inc" / "Acme Corporation"). We measure how many CANONICAL nodes the graph
//       ends up with vs the ground-truth entity count. Ratio 1.0 = zero fragmentation.
//   [2] RETRIEVAL PRECISION / RECALL / MRR / nDCG - a hand-built query->record goldset
//       run through the hybrid retriever (searchWithGraph) and scored with metrics.ts.
//   [3] CONTRADICTION RESOLUTION CORRECTNESS - ingest a fact then a contradicting update;
//       recallMemories must return ONLY the current truth. Reported as a pass-rate.
//
// Determinism: the suite pins the hashing embedder via bunfig preload (test/setup.ts),
// which this test inherits - so every number below is byte-stable across runs.

import { test, expect, describe } from "bun:test"
import { evaluate, type GoldItem, type EvalReport } from "../../src/eval/harness"
import { buildEmbeddedContext, type IngestDoc } from "../../src/embedded/index"

// ── tiny printing helpers (readable metrics table on stdout) ──────────────────────────
const f3 = (n: number) => n.toFixed(3)
const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length))
const dots = (label: string, w = 32) => (label.length >= w ? label + " " : label + " " + ".".repeat(w - label.length - 1) + " ")
const kv = (label: string, value: string, note = "") => console.log(` ${dots(label)} ${value}${note ? "   " + note : ""}`)
const rule = (t: string) => console.log("\n" + t)

// =====================================================================================
// [1] ENTITY-RESOLUTION FRAGMENTATION
// =====================================================================================
// Ground truth: 6 real-world entities. Each is mentioned under multiple SURFACE FORMS,
// scattered across many documents. A memory WITHOUT coreference resolution would create
// one node per surface form (fragmentation ratio ~2.8); a good one collapses each family
// onto a single canonical node (ratio 1.0). Every relation stays WITHIN these 6 entities
// so the node count is unambiguous - any extra node is fragmentation, nothing else.

interface EntityGroup {
  canonical: string
  type: "PERSON" | "ORG"
  forms: string[]
  /** A substring that appears in this entity's canonical id but no other's (for counting
   *  how many nodes carry this identity in the stored graph). */
  idHint: string
}

const GROUPS: EntityGroup[] = [
  { canonical: "Sarah Chen", type: "PERSON", forms: ["Sarah Chen", "Sarah", "Ms. Chen"], idHint: "sarah" },
  { canonical: "Michael Rodriguez", type: "PERSON", forms: ["Michael Rodriguez", "Michael", "Mr. Rodriguez"], idHint: "rodriguez" },
  { canonical: "Priya Patel", type: "PERSON", forms: ["Priya Patel", "Priya", "Ms. Patel"], idHint: "patel" },
  { canonical: "Acme", type: "ORG", forms: ["Acme", "Acme Inc", "Acme Corporation"], idHint: "acme" },
  { canonical: "Globex", type: "ORG", forms: ["Globex", "Globex LLC", "Globex Limited"], idHint: "globex" },
  // Acronym family - "IBM" is introduced BEFORE its expansion so the acronym rule can bind
  // the expansion to the existing short-token node (the resolver's candidate blocking pulls
  // short single-token entities for a multi-word surface). id anchors on "ibm".
  { canonical: "IBM", type: "ORG", forms: ["IBM", "International Business Machines"], idHint: "ibm" },
]

// The synthetic corpus: 9 documents, each asserting a typed triple between two of the 6
// entities, deliberately referring to them by DIFFERENT surface forms across docs. Every
// one of the 17 surface forms appears at least once; every relation endpoint is one of the
// 6 canonical entities (no stray nodes). Ordering guarantees each entity's id-defining form
// is seen first (and "IBM" before its expansion).
const FRAG_DOCS: Array<{ id: string; text: string; ents: Array<[string, "PERSON" | "ORG"]>; rel: [string, string, string] }> = [
  { id: "d1", text: "Sarah Chen works at Acme.", ents: [["Sarah Chen", "PERSON"], ["Acme", "ORG"]], rel: ["Sarah Chen", "Acme", "works_at"] },
  { id: "d2", text: "Michael Rodriguez works at Globex.", ents: [["Michael Rodriguez", "PERSON"], ["Globex", "ORG"]], rel: ["Michael Rodriguez", "Globex", "works_at"] },
  { id: "d3", text: "Priya Patel works at IBM.", ents: [["Priya Patel", "PERSON"], ["IBM", "ORG"]], rel: ["Priya Patel", "IBM", "works_at"] },
  { id: "d4", text: "Ms. Chen mentored Priya during onboarding.", ents: [["Ms. Chen", "PERSON"], ["Priya", "PERSON"]], rel: ["Ms. Chen", "Priya", "mentored"] },
  { id: "d5", text: "Acme Inc partners with Globex LLC on the venture.", ents: [["Acme Inc", "ORG"], ["Globex LLC", "ORG"]], rel: ["Acme Inc", "Globex LLC", "partners_with"] },
  { id: "d6", text: "Michael reports to Sarah on the platform team.", ents: [["Michael", "PERSON"], ["Sarah", "PERSON"]], rel: ["Michael", "Sarah", "reports_to"] },
  { id: "d7", text: "Mr. Rodriguez collaborates with Ms. Patel on research.", ents: [["Mr. Rodriguez", "PERSON"], ["Ms. Patel", "PERSON"]], rel: ["Mr. Rodriguez", "Ms. Patel", "collaborates_with"] },
  { id: "d8", text: "International Business Machines partners with Acme Corporation.", ents: [["International Business Machines", "ORG"], ["Acme Corporation", "ORG"]], rel: ["International Business Machines", "Acme Corporation", "partners_with"] },
  { id: "d9", text: "Globex Limited partners with IBM on infrastructure.", ents: [["Globex Limited", "ORG"], ["IBM", "ORG"]], rel: ["Globex Limited", "IBM", "partners_with"] },
]

describe("[1] entity-resolution fragmentation", () => {
  test("surface-form families collapse to one canonical node each (measured)", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")

    for (const d of FRAG_DOCS) {
      const doc: IngestDoc = {
        recordId: d.id,
        orgId: "o",
        recordName: d.id,
        text: d.text,
        permittedPrincipals: ["u"],
        entities: d.ents.map(([name, type]) => ({ name, type })),
        relations: [{ from: d.rel[0], to: d.rel[1], type: d.rel[2] }],
      }
      await ctx.authorizedIngest("u", doc)
    }

    // What the STORED, ACL-scoped graph actually exposes as canonical nodes.
    const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: "u", orgId: "o" })
    const vids = [...new Set(Object.values(acc))]
    const kg = ctx.graph.getKnowledgeGraph(vids)
    const entityNodes = kg.entities.length

    const groundTruth = GROUPS.length
    const surfaceForms = GROUPS.reduce((n, g) => n + g.forms.length, 0)
    const fragmentationRatio = entityNodes / groundTruth
    const avgFormsPerEntity = surfaceForms / entityNodes

    // REACHABILITY: querying by ANY surface form must reach the SAME canonical node. The
    // resolver is the single funnel every query path (KGQA entity-link, graph adjacency,
    // memory subject_key) goes through, so resolving each surface form and checking the id
    // is the exact "any surface form reaches the same node" claim, made concrete.
    const perGroupIds = GROUPS.map((g) => {
      const ids = new Set(g.forms.map((f) => ctx.store.resolveEntity(f, g.type)?.id))
      // ...and how many STORED nodes carry this identity (must be exactly one).
      const storedNodes = kg.entities.filter((e) => e.id.includes(g.idHint)).length
      return { g, ids, storedNodes, canonicalId: [...ids][0] }
    })
    const distinctCanonical = new Set(perGroupIds.flatMap((p) => [...p.ids]))

    // ── report ──
    rule("========================================================================")
    console.log(" CHITTA DEEP-MEMORY BENCHMARK")
    rule("[1] ENTITY-RESOLUTION FRAGMENTATION")
    kv("documents ingested", String(FRAG_DOCS.length))
    kv("ground-truth entities", String(groundTruth))
    kv("surface forms ingested", String(surfaceForms))
    kv("canonical entity nodes", String(entityNodes))
    kv("fragmentation ratio", f3(fragmentationRatio), "(1.0 = no fragmentation; lower better)")
    kv("avg surface-forms / entity", f3(avgFormsPerEntity), "(variants folded per node)")
    console.log(" per-entity unification (all forms -> one node):")
    for (const p of perGroupIds) {
      const ok = p.ids.size === 1 && p.storedNodes === 1 ? "OK " : "!! "
      console.log(`   ${ok}${pad(p.g.canonical, 20)} [${p.g.forms.join(" | ")}] -> ${p.canonicalId} (${p.storedNodes} node)`)
    }

    // ── assertions (sane, not brittle) ──
    // Every surface form in a family resolves to ONE id, and each family owns exactly one
    // stored node - so the graph is fully consolidated.
    for (const p of perGroupIds) {
      expect(p.ids.size).toBe(1)
      expect(p.storedNodes).toBe(1)
    }
    // No cross-family over-merge either (6 distinct canonicals, not fewer).
    expect(distinctCanonical.size).toBe(groundTruth)
    // Zero-to-low fragmentation overall.
    expect(entityNodes).toBeLessThanOrEqual(groundTruth + 1)
    expect(fragmentationRatio).toBeLessThan(1.5)
  })
})

// =====================================================================================
// [2] RETRIEVAL PRECISION / RECALL / MRR / nDCG
// =====================================================================================
// A hand-built goldset (query -> the ONE record that answers it) run through the hybrid
// retriever. Mix of exact-token and light-paraphrase queries. Scored with the shared
// metrics.ts via the harness, so these are the same numbers a retrieval change would move.

const RETRIEVAL_CORPUS: Array<[string, string]> = [
  ["rec-fraud", "Aviva deploys AI to stop £230M in insurance fraud across the UK market."],
  ["rec-hsbc", "HSBC expands its AI banking partnership with Google Cloud for risk analytics."],
  ["rec-visa", "Visa announced a ChatGPT integration enabling AI agents to make retail purchases."],
  ["rec-k8s", "The platform team migrated to Kubernetes, cutting deployment latency in half."],
  ["rec-churn", "Customer churn dropped after the onboarding redesign and interactive tutorial flow."],
  ["rec-nordic", "Quarterly revenue grew on enterprise subscription expansion in the Nordic region."],
  ["rec-solar", "The new solar microgrid reduced diesel generator usage at the remote mining site."],
  ["rec-vaccine", "Researchers reported an mRNA vaccine candidate with 92% efficacy in phase III trials."],
]

const RETRIEVAL_GOLD: GoldItem[] = [
  { query: "£230M insurance fraud", gold: ["rec-fraud"] },
  { query: "HSBC Google Cloud banking partnership", gold: ["rec-hsbc"] },
  { query: "Visa ChatGPT retail agent purchases", gold: ["rec-visa"] },
  { query: "Kubernetes migration deployment latency", gold: ["rec-k8s"] },
  { query: "onboarding redesign reduced churn", gold: ["rec-churn"] },
  { query: "enterprise subscription revenue Nordics", gold: ["rec-nordic"] },
  { query: "solar microgrid diesel mining site", gold: ["rec-solar"] },
  { query: "mRNA vaccine phase III efficacy", gold: ["rec-vaccine"] },
]

describe("[2] retrieval precision / recall / MRR", () => {
  test("hybrid retriever scored over a hand-built goldset (measured)", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
    for (const [id, text] of RETRIEVAL_CORPUS) {
      await ctx.authorizedIngest("u", { recordId: id, orgId: "o", recordName: id, text, permittedPrincipals: ["u"] })
    }

    const k = 5
    const report: EvalReport = await evaluate(
      RETRIEVAL_GOLD,
      async (q) => (await ctx.searchWithGraph(q, "u", "o")).searchResults.map((r) => r.metadata.recordId as string),
      k,
    )
    // top-1 accuracy: fraction of queries whose FIRST result is the gold record (rr === 1).
    const top1 = report.perQuery.filter((p) => p.rr === 1).length / report.perQuery.length

    rule("[2] RETRIEVAL QUALITY  (hybrid: dense + BM25 + graph, RRF fused)")
    kv("queries / k", `${report.n} / ${report.k}`)
    kv(`recall@${k}`, f3(report.recall), "(gold record present in top-k)")
    kv(`precision@${k}`, f3(report.precision), "(cap 1/k with one gold/query)")
    kv("MRR", f3(report.mrr), "(1/rank of first gold hit)")
    kv(`nDCG@${k}`, f3(report.ndcg), "(rank-quality)")
    kv("top-1 accuracy", f3(top1), "(gold ranked #1)")
    console.log(" per-query (rank of gold):")
    for (const p of report.perQuery) {
      const rank = p.rr > 0 ? String(Math.round(1 / p.rr)) : "miss"
      console.log(`   ${p.recall > 0 ? "OK " : "!! "}${pad(p.query, 40)} rank=${rank}`)
    }

    // Sane thresholds: the hash embedder + BM25 should retrieve every gold record and rank
    // it at (or very near) the top. Deliberately below the ~1.0 we expect, to avoid brittle.
    expect(report.recall).toBeGreaterThanOrEqual(0.85)
    expect(report.mrr).toBeGreaterThanOrEqual(0.7)
    expect(report.ndcg).toBeGreaterThanOrEqual(0.7)
    expect(top1).toBeGreaterThanOrEqual(0.6)
  })
})

// =====================================================================================
// [3] CONTRADICTION RESOLUTION CORRECTNESS
// =====================================================================================
// Ingest a fact, then a contradicting update, then assert recallMemories returns ONLY the
// current truth (the superseded / retired belief is gone from recall, history kept). Both
// the FUNCTIONAL-predicate path (a new value overwrites, e.g. works_at) and the SEMANTIC
// path (antonym / negation retires the older belief) are covered. Reported as a pass-rate.

interface ContradictionCase {
  name: string
  subject: string
  query: string
  old: { from: string; to: string; type: string } // asserted first
  new: { from: string; to: string; type: string } // contradicts it
  oldMemory: string // exact memory string that must NOT survive recall
  newMemory: string // exact memory string that MUST be the current truth
}

const CONTRADICTION_CASES: ContradictionCase[] = [
  {
    name: "functional works_at (Google -> Meta)", subject: "Sarah", query: "where does Sarah work",
    old: { from: "Sarah", to: "Google", type: "works_at" }, new: { from: "Sarah", to: "Meta", type: "works_at" },
    oldMemory: "Sarah works at Google", newMemory: "Sarah works at Meta",
  },
  {
    name: "functional lives_in (Berlin -> Munich)", subject: "Alex", query: "where does Alex live",
    old: { from: "Alex", to: "Berlin", type: "lives_in" }, new: { from: "Alex", to: "Munich", type: "lives_in" },
    oldMemory: "Alex lives in Berlin", newMemory: "Alex lives in Munich",
  },
  {
    name: "functional led_by (Alice -> Bob)", subject: "Acme", query: "who leads Acme",
    old: { from: "Acme", to: "Alice", type: "led_by" }, new: { from: "Acme", to: "Bob", type: "led_by" },
    oldMemory: "Acme led by Alice", newMemory: "Acme led by Bob",
  },
  {
    name: "functional status_is (planning -> shipped)", subject: "ProjectOrion", query: "status of ProjectOrion",
    old: { from: "ProjectOrion", to: "planning", type: "status_is" }, new: { from: "ProjectOrion", to: "shipped", type: "status_is" },
    oldMemory: "ProjectOrion status is planning", newMemory: "ProjectOrion status is shipped",
  },
  {
    name: "semantic antonym (supports -> opposes)", subject: "Dana", query: "Dana ProposalX",
    old: { from: "Dana", to: "ProposalX", type: "supports" }, new: { from: "Dana", to: "ProposalX", type: "opposes" },
    oldMemory: "Dana supports ProposalX", newMemory: "Dana opposes ProposalX",
  },
  {
    name: "semantic negation (likes -> no_longer_likes)", subject: "Sam", query: "Sam Tea",
    old: { from: "Sam", to: "Tea", type: "likes" }, new: { from: "Sam", to: "Tea", type: "no_longer_likes" },
    oldMemory: "Sam likes Tea", newMemory: "Sam no longer likes Tea",
  },
]

describe("[3] contradiction resolution correctness", () => {
  test("recall returns only the current truth after a contradicting update (measured)", async () => {
    const results: Array<{ c: ContradictionCase; passed: boolean; recalled: string[] }> = []

    for (const c of CONTRADICTION_CASES) {
      // Fresh store per case: isolate each contradiction so cases can't cross-contaminate.
      const ctx = buildEmbeddedContext({ path: ":memory:" })
      ctx.ingestor.registerUser("u", "o", "u@x.com", "admin")
      await ctx.authorizedIngest("u", {
        recordId: "r1", orgId: "o", recordName: "fact", text: c.oldMemory, permittedPrincipals: ["u"],
        relations: [{ from: c.old.from, to: c.old.to, type: c.old.type }],
      })
      await ctx.authorizedIngest("u", {
        recordId: "r2", orgId: "o", recordName: "update", text: c.newMemory, permittedPrincipals: ["u"],
        relations: [{ from: c.new.from, to: c.new.to, type: c.new.type }],
      })
      const recalled = (await ctx.recallMemories(c.query, "u", "o", 50)).map((m) => m.memory)
      // Correct iff the NEW truth is recalled and the OLD (contradicted) belief is NOT.
      const passed = recalled.includes(c.newMemory) && !recalled.includes(c.oldMemory)
      results.push({ c, passed, recalled })
    }

    const passRate = results.filter((r) => r.passed).length / results.length

    rule("[3] CONTRADICTION RESOLUTION  (recall must return ONLY current truth)")
    kv("cases", String(results.length))
    kv("pass-rate", f3(passRate), "(1.0 = every contradiction resolved)")
    for (const r of results) {
      console.log(`   ${r.passed ? "PASS" : "FAIL"}  ${pad(r.c.name, 40)} recall=[${r.recalled.join(" | ")}]`)
    }
    rule("========================================================================")

    // Every current memory returned by recall must be a current-truth string (no stale belief).
    for (const r of results) {
      expect(r.recalled).toContain(r.c.newMemory)
      expect(r.recalled).not.toContain(r.c.oldMemory)
    }
    expect(passRate).toBeGreaterThanOrEqual(0.8) // deterministic mechanism -> expect 1.0
  })
})
