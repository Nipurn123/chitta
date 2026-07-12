// Usage-reinforced memory dynamics: memories that get recalled AND used strengthen
// (recency x frequency x importance), unused ones decay - ranking only, never deletion.
// Plus the schema migration: a pre-existing DB without the usage columns upgrades in
// place on open. Uses the deterministic hashing embedder (bunfig preload).
import { test, expect, describe, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEmbeddedContext } from "../../src/embedded/index"
import { migrate } from "../../src/embedded/store/schema"
import { MemoryRepo, memoryStrength } from "../../src/embedded/store/memories"

const ORG = "acme"
const DAY = 864e5

// Two memories with the SAME embedding = exactly equal semantic relevance to any query,
// so ranking differences can only come from the strength blend.
function twin(repo: MemoryRepo, id: string, vid: string, text: string, embedding: number[]): void {
  repo.insert({ id, orgId: ORG, virtualRecordId: vid, subjectKey: `t|note|${id}`, memory: text, embedding })
}

afterEach(() => {
  delete process.env.CONTEXT_MEMORY_REINFORCE
  delete process.env.CONTEXT_MEMORY_HALFLIFE_DAYS
})

describe("usage-reinforced memory strength", () => {
  test("a reinforced memory outranks an equally-relevant unreinforced one (end to end)", async () => {
    const ctx = buildEmbeddedContext({ path: ":memory:" })
    ctx.ingestor.registerUser("alice", ORG, "a@acme.com", "admin")
    // an accessible ACL anchor for the memories (vid defaults to the recordId)
    await ctx.authorizedIngest("alice", { recordId: "anchor", orgId: ORG, recordName: "anchor", text: "team runbook notes" })
    const emb = await ctx.embeddings.embedDense("deploy runbook")
    twin(ctx.store.memories, "m-a", "anchor", "Runbook step alpha", emb)
    twin(ctx.store.memories, "m-b", "anchor", "Runbook step beta", emb)
    // identical write times → identical baseline strength (insertion order is the tiebreak)
    const t = Date.now() - 5 * DAY
    ctx.store.db.query("UPDATE memories SET created_at = ?, updated_at = ? WHERE id IN ('m-a','m-b')").run(t, t)

    // m-b (inserted SECOND - it would lose every tiebreak) gets recalled-and-used
    expect(ctx.store.memories.reinforce(["m-b"])).toBe(1)
    expect(ctx.store.memories.reinforce(["m-b"])).toBe(1)

    // store-level ranking: strength puts the used memory first
    const rows = ctx.store.memories.recall(["anchor"])
    const twins = rows.filter((r) => r.id.startsWith("m-"))
    expect(twins.map((r) => r.id)).toEqual(["m-b", "m-a"])
    expect(twins[0].strength!).toBeGreaterThan(twins[1].strength!)
    expect(twins[0].use_count).toBe(2)
    expect(twins[0].last_used_at).not.toBeNull()

    // full recall path: equal cosine → the strength order carries through (stable sort)
    const mems = await ctx.recallMemories("deploy runbook", "alice", ORG, 10)
    const beta = mems.findIndex((m) => m.memory.includes("beta"))
    const alpha = mems.findIndex((m) => m.memory.includes("alpha"))
    expect(beta).toBeGreaterThanOrEqual(0)
    expect(alpha).toBeGreaterThanOrEqual(0)
    expect(beta).toBeLessThan(alpha)
  })

  test("decay: an old unused memory ranks below a fresh used one - but is NOT deleted", () => {
    const db = new Database(":memory:")
    migrate(db)
    const repo = new MemoryRepo(db)
    twin(repo, "m-old", "v", "Old habit nobody uses", [0.5, 0.5])
    twin(repo, "m-used", "v", "The habit the agent lives by", [0.5, 0.5])
    // both written 90 days ago; the OLD one even slightly newer by WRITE time, so the
    // legacy (write-recency) order would put it first - only usage can flip that
    const old = Date.now() - 90 * DAY
    db.query("UPDATE memories SET created_at = ?, updated_at = ?").run(old, old)
    db.query("UPDATE memories SET updated_at = ? WHERE id = 'm-old'").run(old + 60_000)
    repo.reinforce(["m-used"])

    const rows = repo.recall(["v"])
    expect(rows[0].id).toBe("m-used") // fresh use beats a slightly-fresher write
    expect(rows.map((r) => r.id)).toContain("m-old") // decayed = outranked, never deleted
    expect(rows[0].strength!).toBeGreaterThan(rows[1].strength!)

    // CONTEXT_MEMORY_REINFORCE=0 falls back to the legacy write-recency order
    process.env.CONTEXT_MEMORY_REINFORCE = "0"
    expect(repo.recall(["v"])[0].id).toBe("m-old")
  })

  test("half-life is tunable: CONTEXT_MEMORY_HALFLIFE_DAYS trades recency against importance", () => {
    // unused 10-day-old memory at full confidence vs fresh memory at low confidence
    const aged = { updated_at: Date.now() - 10 * DAY, use_count: 0, last_used_at: null, confidence: 1 }
    const fresh = { updated_at: Date.now(), use_count: 0, last_used_at: null, confidence: 0.4 }
    // slow forgetting (default 30d): the aged-but-trusted memory still wins
    expect(memoryStrength(aged)).toBeGreaterThan(memoryStrength(fresh))
    // fast forgetting (1d half-life): ten half-lives flatten it - freshness wins
    process.env.CONTEXT_MEMORY_HALFLIFE_DAYS = "1"
    expect(memoryStrength(aged)).toBeLessThan(memoryStrength(fresh))
  })

  test("migration: a pre-existing DB without the usage columns opens and upgrades in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "chitta-dynamics-"))
    try {
      const file = join(dir, "legacy.db")
      // fabricate a v1-era DB: the original memories shape, none of the later columns
      // (no kind/occurred_at/actor_ids/confidence, no use_count/last_used_at)
      const legacy = new Database(file)
      legacy.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          org_id TEXT,
          virtual_record_id TEXT,
          subject_key TEXT,
          memory TEXT NOT NULL,
          embedding TEXT,
          is_static INTEGER NOT NULL DEFAULT 0,
          is_forgotten INTEGER NOT NULL DEFAULT 0,
          forget_after INTEGER,
          forget_reason TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          parent_id TEXT,
          root_id TEXT,
          is_latest INTEGER NOT NULL DEFAULT 1,
          relation TEXT,
          source_record_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      legacy
        .query("INSERT INTO memories (id, org_id, virtual_record_id, subject_key, memory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("m-legacy", ORG, "v-legacy", "e:sarah|works_at", "Sarah works at Google", Date.now(), Date.now())
      legacy.close()

      // opening through the real stack runs the migration ladder
      const ctx = buildEmbeddedContext({ path: file })
      const cols = (ctx.store.db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols).toContain("use_count")
      expect(cols).toContain("last_used_at")

      // the legacy row is intact, recallable, and defaults to never-used
      const rows = ctx.store.memories.recall(["v-legacy"])
      expect(rows.length).toBe(1)
      expect(rows[0].memory).toBe("Sarah works at Google")
      expect(rows[0].use_count).toBe(0)
      expect(rows[0].last_used_at).toBeNull()

      // and reinforcement works immediately on the migrated row
      expect(ctx.store.memories.reinforce([rows[0].id])).toBe(1)
      expect(ctx.store.memories.recall(["v-legacy"])[0].use_count).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
