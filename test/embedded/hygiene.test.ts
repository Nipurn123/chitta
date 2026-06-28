// Extraction hygiene: strip markdown noise from returned lines + drop web boilerplate
// (cookie banners / nav / subscribe) at ingest so it never becomes a junk entity.
import { test, expect, describe } from "bun:test"
import { cleanLine, isBoilerplate, stripBoilerplate } from "../../src/embedded/extract"
import { SqliteStore } from "../../src/embedded/sqlite-store"
import { Ingestor } from "../../src/embedded/ingest"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"

describe("cleanLine strips markdown", () => {
  test("removes bold markers, headings, bullets", () => {
    expect(cleanLine("**June 8, 2026**: Aviva deploys AI")).toBe("June 8, 2026: Aviva deploys AI")
    expect(cleanLine("## Heading")).toBe("Heading")
    expect(cleanLine("- HSBC expands AI banking partnership")).toBe("HSBC expands AI banking partnership")
    expect(cleanLine("> quoted line")).toBe("quoted line")
  })
})

describe("boilerplate detection", () => {
  test("flags cookie/nav/subscribe junk, keeps real sentences", () => {
    expect(isBoilerplate("Manage Cookie Consent")).toBe(true)
    expect(isBoilerplate("Privacy Policy")).toBe(true)
    expect(isBoilerplate("Skip to content")).toBe(true)
    expect(isBoilerplate("Subscribe")).toBe(true)
    expect(isBoilerplate("Accept")).toBe(true)
    expect(isBoilerplate("Aviva deploys AI to stop £230M in insurance fraud")).toBe(false)
  })

  test("stripBoilerplate removes junk lines but keeps the real fact", () => {
    const scraped = `Manage Cookie Consent
Accept
Deny
Skip to content
Aviva deploys AI to stop £230M in sophisticated insurance fraud
Subscribe
Privacy Policy`
    const out = stripBoilerplate(scraped)
    expect(out).toContain("Aviva deploys AI to stop £230M")
    expect(out).not.toContain("Cookie Consent")
    expect(out).not.toContain("Privacy Policy")
    expect(out).not.toContain("Skip to content")
  })
})

describe("ingest no longer creates cookie/nav junk entities", () => {
  test("a scraped page yields the real entity, not boilerplate ones", async () => {
    const store = new SqliteStore(":memory:")
    const ing = new Ingestor(store, new LocalHashEmbeddings())
    ing.registerUser("u", "o", "u@x.com", "admin")
    const scraped = `Manage Cookie Consent
We use technologies like cookies to store device information.
Accept
Deny
Privacy Policy
Aviva deploys AI to stop £230M in sophisticated insurance fraud.
Subscribe now`
    await ing.ingest({ recordId: "r1", orgId: "o", recordName: "news.txt", text: scraped, permittedPrincipals: ["u"] })
    const labels = (store.db.query("SELECT json_extract(data,'$.label') l FROM nodes WHERE coll='entities'").all() as Array<{ l: string }>).map((r) => r.l)
    expect(labels.some((l) => /aviva/i.test(l))).toBe(true) // real entity kept
    expect(labels.some((l) => /cookie|privacy/i.test(l))).toBe(false) // junk gone
  })
})
