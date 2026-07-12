// The shareable artifact: renderGraphHtml turns an accessible knowledge graph into ONE
// self-contained, interactive HTML file (Chitta's "graph.html"). Verifies it's self-contained
// (no external resources), inlines the data, drops isolated nodes, is XSS-safe, and degrades
// to a friendly empty state — so it's always safe to write, open, and share.

import { describe, expect, test } from "bun:test"
import { renderGraphHtml } from "../../src/embedded/graph-html"

describe("renderGraphHtml (the shareable graph.html)", () => {
  test("self-contained page with the graph inlined; isolated nodes dropped", () => {
    const html = renderGraphHtml(
      {
        entities: [
          { id: "e1", label: "Sarah Chen", type: "PERSON" },
          { id: "e2", label: "Meta", type: "ORG" },
          { id: "e3", label: "Lonely Concept", type: "CONCEPT" }, // in no relation
        ],
        relations: [{ from: "e1", to: "e2", type: "works_at", weight: 1 }],
      },
      { title: "Test graph" },
    )
    expect(html).toStartWith("<!doctype html>")
    expect(html).toContain("Test graph")
    expect(html).toContain("Sarah Chen")
    expect(html).toContain("Meta")
    expect(html).not.toContain("Lonely Concept") // isolated ⇒ dropped when a graph exists
    // fully self-contained: no network anything
    expect(html).not.toContain("http://")
    expect(html).not.toContain("https://")
    expect(html).not.toContain("src=")
    expect(html).toContain("var DATA=") // data is inlined
  })

  test("XSS-safe: a hostile label cannot break out of the <script> or inject markup", () => {
    const html = renderGraphHtml({
      entities: [
        { id: "x", label: "</script><img src=x onerror=alert(1)>", type: "PERSON" },
        { id: "y", label: "Y", type: "ORG" },
      ],
      relations: [{ from: "x", to: "y", type: "knows" }],
    })
    expect(html).not.toContain("</script><img") // "<" is escaped to < inside the JSON
  })

  test("empty graph renders the friendly empty state, never a blank/broken page", () => {
    const html = renderGraphHtml({ entities: [], relations: [] })
    expect(html).toStartWith("<!doctype html>")
    expect(html).toContain("No connected concepts yet")
  })
})
