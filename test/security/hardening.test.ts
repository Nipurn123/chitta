import { test, expect, describe } from "bun:test"
import { sanitizeText, sanitizeLabel, sanitizeBody, hasHiddenChars, MAX_LABEL_LEN } from "../../src/security/sanitize"
import { renderRecalled, wrapUntrusted, SPOTLIGHT_PREAMBLE } from "../../src/security/spotlight"
import { TokenBucket, guardIngest, IngestLimitError, MAX_INGEST_BYTES } from "../../src/security/limits"

describe("sanitize", () => {
  test("strips bidi override (Trojan Source CVE-2021-42574)", () => {
    const evil = "safe‮evil‬"
    expect(sanitizeText(evil)).toBe("safeevil")
    expect(hasHiddenChars(evil)).toBe(true)
  })
  test("strips zero-width / hidden instruction chars", () => {
    expect(sanitizeText("hel​lo‍﻿")).toBe("hello")
  })
  test("strips C0/C1 control chars but keeps \\t \\n \\r", () => {
    expect(sanitizeText("abc")).toBe("abc")
    expect(sanitizeText("line1\nline2\tx")).toBe("line1\nline2\tx")
  })
  test("NFC-normalizes", () => {
    // 'e' + combining acute → single é
    expect(sanitizeText("é").normalize("NFC")).toBe(sanitizeText("é"))
    expect(sanitizeText("é")).toBe("é")
  })
  test("clean ASCII is unchanged (no-op for normal content)", () => {
    expect(sanitizeBody("Acme builds privacy-first AI.\n\nSecond para.")).toBe("Acme builds privacy-first AI.\n\nSecond para.")
  })
  test("sanitizeLabel collapses whitespace and caps length", () => {
    expect(sanitizeLabel("  hello   world  ")).toBe("hello world")
    expect(sanitizeLabel("x".repeat(500)).length).toBe(MAX_LABEL_LEN)
  })
  test("hasHiddenChars false on clean text", () => {
    expect(hasHiddenChars("totally normal text 123")).toBe(false)
  })
})

describe("spotlight (memory-poisoning defense)", () => {
  test("wraps recalled content as untrusted, attributed data", () => {
    const w = wrapUntrusted("the secret plan", "Roadmap", 1)
    expect(w).toContain('<untrusted_memory id="1" source="Roadmap">')
    expect(w).toContain("the secret plan")
    expect(w).toContain("</untrusted_memory>")
  })
  test("strips hidden chars from recalled content at the boundary too", () => {
    expect(wrapUntrusted("ev‮il", "s", 1)).toContain("evil")
  })
  test("renderRecalled prepends the data-not-instructions preamble", () => {
    const out = renderRecalled([{ content: "fact A", source: "Doc" }])
    expect(out.startsWith(SPOTLIGHT_PREAMBLE)).toBe(true)
    expect(out).toContain("fact A")
    expect(SPOTLIGHT_PREAMBLE.toLowerCase()).toContain("never")
  })
  test("empty results → empty string", () => {
    expect(renderRecalled([])).toBe("")
  })
})

describe("ingest limits", () => {
  test("guardIngest throws on oversized payload", () => {
    const big = "x".repeat(MAX_INGEST_BYTES + 1)
    expect(() => guardIngest(big)).toThrow(IngestLimitError)
  })
  test("guardIngest passes normal payloads", () => {
    expect(() => guardIngest("a small document")).not.toThrow()
  })
  test("TokenBucket enforces burst then refuses", () => {
    const b = new TokenBucket(2, 0) // 2 burst, no refill
    expect(b.tryRemove()).toBe(true)
    expect(b.tryRemove()).toBe(true)
    expect(b.tryRemove()).toBe(false)
  })
})
