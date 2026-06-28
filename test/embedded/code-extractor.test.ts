// Code → graph (Graphify capability, TS-native tree-sitter). Proves we parse real
// source into a code graph and that it flows through ingest + the graph-query layer
// (so context_relate / path / impact work on CODE, not just prose).
import { test, expect, describe } from "bun:test"
import { CodeExtractor } from "../../src/embedded/code-extractor"
import { SqliteStore } from "../../src/embedded/sqlite-store"
import { SqliteGraphProvider } from "../../src/embedded/sqlite-graph-provider"
import { GraphQueryService } from "../../src/embedded/graph-query"
import { Ingestor } from "../../src/embedded/ingest"
import { LocalHashEmbeddings } from "../../src/embedded/local-embeddings"

const PY = `import os
def greet(name):
    return format_name(name)
def format_name(n):
    return n.upper()
class Service:
    def run(self):
        return greet("world")`

describe("CodeExtractor (tree-sitter AST)", () => {
  test("detectLanguage maps extensions", () => {
    expect(CodeExtractor.detectLanguage("app.py")).toBe("python")
    expect(CodeExtractor.detectLanguage("main.ts")).toBe("typescript")
    expect(CodeExtractor.detectLanguage("lib.rs")).toBe("rust")
    expect(CodeExtractor.detectLanguage("notes.txt")).toBeNull()
    expect(CodeExtractor.detectLanguage(undefined)).toBeNull()
  })

  test("extracts functions, classes, calls, imports with confidence tiers", async () => {
    const { entities, relations } = await new CodeExtractor().extractCode(PY, "python", "app.py")
    const types = entities.map((e) => `${e.type}:${e.label}`)
    expect(types).toContain("FUNCTION:greet")
    expect(types).toContain("CLASS:Service")
    expect(types).toContain("MODULE:os")

    const rel = (from: string, type: string, to: string) =>
      relations.find((r) => r.from.endsWith(from) && r.type === type && r.to.endsWith(to))
    expect(rel("app-py", "imports", "os")).toBeTruthy()
    expect(rel("app-py", "defines", "greet")).toBeTruthy()
    // greet calls format_name - BOTH locally defined ⇒ EXTRACTED (1.0)
    expect(rel("greet", "calls", "format-name")?.confidence).toBe(1)
    // format_name calls .upper() - external ⇒ INFERRED (0.7)
    expect(rel("format-name", "calls", "upper")?.confidence).toBe(0.7)
    // Service.run is a method of the class
    expect(rel("service", "has_method", "run")).toBeTruthy()
  })

  test("registers all 36 tree-sitter grammars", () => {
    expect(CodeExtractor.languages().length).toBe(36)
    expect(CodeExtractor.languages()).toContain("python")
    expect(CodeExtractor.languages()).toContain("rust")
    expect(CodeExtractor.languages()).toContain("solidity")
  })

  test("extracts across mainstream languages (go, java, ruby, rust)", async () => {
    const ex = new CodeExtractor()
    const cases: Array<[string, string, string, string]> = [
      ["go", "m.go", `package m\nimport "fmt"\nfunc Greet(n string){ fmt.Println(n) }\ntype St struct{}\nfunc (s St) Run(){ Greet("x") }`, "Greet"],
      ["java", "A.java", `class A{ void run(){ helper(); } int helper(){ return 1; } }`, "helper"],
      ["ruby", "a.rb", `def greet(n)\n  helper(n)\nend`, "greet"],
      ["rust", "a.rs", `fn greet(n:&str){ helper(n); }\nfn run(){ greet("x"); }`, "greet"],
    ]
    for (const [lang, name, code, expectSym] of cases) {
      const { entities, relations } = await ex.extractCode(code, lang, name)
      const defined = entities.some((e) => e.label === expectSym)
      const hasCalls = relations.some((r) => r.type === "calls")
      expect(defined).toBe(true)
      expect(hasCalls).toBe(true)
    }
  })
})

describe("code graph flows through ingest + graph-query (strict superset)", () => {
  test("ingesting a .py file makes the code graph queryable via the graph layer", async () => {
    const store = new SqliteStore(":memory:")
    const emb = new LocalHashEmbeddings()
    const ing = new Ingestor(store, emb)
    ing.registerUser("dev", "org1", "d@x.com", "admin")
    await ing.ingest({ recordId: "f1", orgId: "org1", recordName: "app.py", text: PY, permittedPrincipals: ["dev"] })

    const gq = new GraphQueryService(new SqliteGraphProvider(store))
    // neighbors of greet: defines(file, in) + calls(format_name, out) + called-by run (in)
    const nb = await gq.neighbors("greet", "dev", "org1")
    expect(nb).not.toBeNull()
    const labels = nb!.neighbors.map((n) => n.label)
    expect(labels).toContain("format_name")

    // "how is the Service connected to format_name?" - a real graph path over code
    const path = await gq.pathBetween("Service", "format_name", "dev", "org1")
    expect(path.found).toBe(true) // Service →has_method→ run →calls→ greet →calls→ format_name
  })
})
