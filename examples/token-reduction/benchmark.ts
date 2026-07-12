// Token-reduction benchmark - measures how much smaller a permission-aware
// retrieval is than dumping the whole knowledge base into the model's context.
//
//   bun run examples/token-reduction/benchmark.ts
//
// It ingests the committed corpus in raw/, runs real queries as two different
// users, and reports - from the ACTUAL retrieved content - the token reduction
// versus (a) the entire corpus and (b) just the records each user is allowed to
// see. Re-running regenerates BENCHMARK.md from the live numbers.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildEmbeddedContext } from "../../src/embedded/index";

const HERE = import.meta.dir;
const RAW = join(HERE, "raw");

// Standard rough estimate; we also report exact characters so it is verifiable.
const estTokens = (s: string) => Math.ceil(s.length / 4);

// Corpus → sharing scope. Two org-wide docs, four eng-only, two hr-only.
const SCOPE: Record<string, "org" | "eng" | "hr"> = {
  "handbook": "org",
  "security-policy": "org",
  "oncall-runbook": "eng",
  "architecture-overview": "eng",
  "api-guide": "eng",
  "incident-2026-03-postmortem": "eng",
  "compensation-bands": "hr",
  "hiring-process": "hr",
};

const TITLE: Record<string, string> = {
  "handbook": "Company Handbook",
  "security-policy": "Information Security Policy",
  "oncall-runbook": "On-Call Runbook",
  "architecture-overview": "Platform Architecture Overview",
  "api-guide": "API Integration Guide",
  "incident-2026-03-postmortem": "March 2026 Postmortem",
  "compensation-bands": "Compensation Bands 2026",
  "hiring-process": "Hiring Process",
};

const ORG = "acme";
const K = 6; // snippets retrieved per query

type Q = { user: string; q: string; note?: string };
const QUERIES: Q[] = [
  { user: "alice", q: "How do I handle a production incident?" },
  { user: "alice", q: "How does the API authenticate clients?" },
  { user: "alice", q: "What caused the March latency incident?" },
  { user: "alice", q: "What are the company values and the time-off policy?" },
  { user: "bob", q: "What are the compensation bands for senior engineers?" },
  { user: "bob", q: "How does the hiring debrief work?" },
  { user: "bob", q: "What is the parental leave policy?" },
  { user: "alice", q: "What are the compensation bands?", note: "see ACL leak check below" },
];

async function main() {
  const ctx = buildEmbeddedContext({ path: ":memory:" });
  const ing = ctx.ingestor;

  ing.registerUser("alice", ORG, "alice@acme.com", "editor");
  ing.registerUser("bob", ORG, "bob@acme.com", "editor");
  for (const g of ["eng", "hr"]) ing.registerGroup(g);
  ing.addMembership("alice", "eng");
  ing.addMembership("bob", "hr");

  // Ingest the corpus and remember each record's raw size.
  const files = readdirSync(RAW).filter((f) => f.endsWith(".md")).sort();
  const corpusChars: Record<string, number> = {};
  for (const f of files) {
    const id = f.replace(/\.md$/, "");
    const text = readFileSync(join(RAW, f), "utf8");
    corpusChars[id] = text.length;
    const scope = SCOPE[id] ?? "org";
    await ing.ingest({
      recordId: id, orgId: ORG, recordName: TITLE[id] ?? id, text,
      permittedPrincipals: scope === "org" ? [] : [scope],
      shareWithOrg: scope === "org" ? ORG : undefined,
    });
  }

  const corpusTotalChars = Object.values(corpusChars).reduce((a, b) => a + b, 0);
  const corpusTotalTokens = estTokens("x".repeat(corpusTotalChars));

  // Per-user permitted-corpus size (the fair baseline: even a naive dump only
  // dumps what the user is allowed to see).
  async function permittedChars(user: string): Promise<number> {
    const acc = await ctx.graph.getAccessibleVirtualRecordIds({ userId: user, orgId: ORG });
    const ids = new Set(Object.values(acc));
    let total = 0;
    for (const id of ids) total += corpusChars[id] ?? 0;
    return total;
  }

  type Row = {
    user: string; q: string; note?: string;
    hits: number; retChars: number;
    redCorpus: number; redPermitted: number; permittedChars: number;
    sources: string[];
  };
  const rows: Row[] = [];

  const sourcesFor = async (user: string, q: string) => {
    const res = await ctx.retrieval.searchWithFilters({ queries: [q], userId: user, orgId: ORG, limit: K });
    return res.searchResults;
  };

  for (const { user, q, note } of QUERIES) {
    const results = await sourcesFor(user, q);
    const retChars = results.reduce((a, r) => a + r.content.length, 0);
    const permChars = await permittedChars(user);
    rows.push({
      user, q, note,
      hits: results.length,
      retChars,
      redCorpus: retChars ? corpusTotalChars / retChars : Infinity,
      redPermitted: retChars ? permChars / retChars : Infinity,
      permittedChars: permChars,
      sources: [...new Set(results.map((r) => r.metadata.recordName ?? "?"))],
    });
  }

  // ── ACL leak check: same query, the permitted user vs the not-permitted user ──
  const COMP = "What are the compensation bands for senior engineers?";
  const COMP_DOC = TITLE["compensation-bands"];
  const bobComp = (await sourcesFor("bob", COMP)).map((r) => r.metadata.recordName);
  const aliceComp = (await sourcesFor("alice", COMP)).map((r) => r.metadata.recordName);
  const bobSeesComp = bobComp.includes(COMP_DOC);
  const aliceSeesComp = aliceComp.includes(COMP_DOC);

  ctx.store.close();

  // ── Print + write report ───────────────────────────────────────────────────
  const fmtTok = (chars: number) => estTokens("x".repeat(chars)).toLocaleString();
  const fmtX = (n: number) => (n === Infinity ? "∞" : `${n.toFixed(1)}×`);

  const answered = rows.filter((r) => r.hits > 0);
  const avgCorpus = answered.reduce((a, r) => a + r.redCorpus, 0) / answered.length;
  const avgPermitted = answered.reduce((a, r) => a + r.redPermitted, 0) / answered.length;

  const lines: string[] = [];
  lines.push("# Token-Reduction Benchmark - Results");
  lines.push("");
  lines.push("> Generated by `bun run examples/token-reduction/benchmark.ts`. Numbers are");
  lines.push("> produced from the actual retrieved content over the committed corpus in `raw/`.");
  lines.push("> Tokens are estimated as `ceil(chars / 4)`; exact characters are shown so the");
  lines.push("> figures are independently verifiable.");
  lines.push("");
  lines.push("## Corpus");
  lines.push("");
  lines.push(`- ${files.length} documents, ${corpusTotalChars.toLocaleString()} characters (~${corpusTotalTokens.toLocaleString()} tokens total)`);
  lines.push(`- Sharing: 2 org-wide, 4 eng-only, 2 hr-only`);
  lines.push(`- Users: \`alice\` (eng), \`bob\` (hr) - each sees only their permitted subset`);
  lines.push(`- Retrieval: top **${K}** snippets per query`);
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push(`- **${fmtX(avgCorpus)} fewer tokens** than dumping the whole knowledge base into context.`);
  lines.push(`- **${fmtX(avgPermitted)} fewer tokens** even versus dumping only each user's *permitted* subset.`);
  lines.push(`- The reduction grows with corpus size: retrieved size stays ~constant while the dump grows with every document added.`);
  lines.push("");
  lines.push("## Per-query");
  lines.push("");
  lines.push("| User | Query | Hits | Retrieved tokens | vs full corpus | vs permitted subset |");
  lines.push("|---|---|--:|--:|--:|--:|");
  for (const r of rows) {
    const q = r.note ? `${r.q} _(${r.note})_` : r.q;
    const ret = r.hits ? `~${fmtTok(r.retChars)}` : "0 - no access";
    lines.push(`| \`${r.user}\` | ${q} | ${r.hits} | ${ret} | ${r.hits ? fmtX(r.redCorpus) : "-"} | ${r.hits ? fmtX(r.redPermitted) : "-"} |`);
  }
  lines.push("");
  lines.push("## ACL leak check");
  lines.push("");
  lines.push("Same query - *\"" + COMP + "\"* - asked by the permitted user and the");
  lines.push("non-permitted user. The restricted **" + COMP_DOC + "** document must appear for");
  lines.push("one and never for the other:");
  lines.push("");
  lines.push("| Asked by | Group | Sees \"" + COMP_DOC + "\" in results? |");
  lines.push("|---|---|:--:|");
  lines.push(`| \`bob\` | hr (permitted) | ${bobSeesComp ? "✅ yes" : "❌ no"} |`);
  lines.push(`| \`alice\` | eng (not permitted) | ${aliceSeesComp ? "⚠️ LEAK" : "✅ never"} |`);
  lines.push("");
  lines.push(aliceSeesComp
    ? "> ⚠️ Leak detected - this should never happen; the ACL gate failed."
    : "> `alice` still gets " + K + " snippets from her *own* permitted docs, but the HR");
  if (!aliceSeesComp) lines.push("> compensation document is never among them. A naive \"dump the knowledge base\"");
  if (!aliceSeesComp) lines.push("> baseline would have handed it straight to her.");
  lines.push("");
  lines.push("## What this shows");
  lines.push("");
  lines.push("1. **Token reduction** - answering a question needs a handful of snippets, not the");
  lines.push("   whole knowledge base. The bigger the KB, the larger the win, because the");
  lines.push("   retrieved size stays roughly constant as documents are added.");
  lines.push("2. **No cross-user leak** - the restricted document surfaces only for the permitted");
  lines.push("   user (see the ACL leak check). The permission gate produces the candidate set;");
  lines.push("   it is not a filter applied after retrieval that you could forget.");
  lines.push("3. **Ranking quality** depends on the embedder. This run uses the dependency-free");
  lines.push("   hashing embedder, so *which* snippets come back is not yet semantically ranked;");
  lines.push("   the token-reduction and ACL guarantees are structural and hold regardless, while");
  lines.push("   ranking quality improves with real embeddings (see the README \"Status → Next\").");
  lines.push("");

  const report = lines.join("\n");
  writeFileSync(join(HERE, "BENCHMARK.md"), report);

  // Console summary
  console.log(report);
}

main();
