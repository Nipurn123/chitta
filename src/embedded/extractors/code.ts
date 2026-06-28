// Code → graph extractor (the Graphify capability, ported TS-native). Parses source
// with tree-sitter (WASM grammars, no Python, no servers) into the SAME entity/edge
// shape every other extractor produces - so the moment code nodes land, all the rest
// (ACL, vector recall, bi-temporal edges, context_relate / path / impact / central)
// works on them for free. This is what makes us a STRICT SUPERSET of Graphify: code
// graph + NL graph + permissions + vectors + temporal, in one embedded store.
//
// ALL 36 tree-sitter grammars are supported. Rather than hand-list node types per
// grammar (brittle across 36), we CLASSIFY nodes generically: tree-sitter follows
// strong conventions (`*_declaration`/`*_definition`/`*_item` for defs,
// `call_expression`/`*_invocation`/`command` for calls, `import|use|include|...` for
// imports), with a small OUTLIERS table for the few grammars that don't (Ruby,
// Elixir, Lua, Elm, …). Static AST is the RIGHT tool here (unlike prose): code has a
// formal grammar, so extraction is exact. Grammars are an optionalDependency; if they
// fail to load we degrade to an empty extraction (never crash).
// Re-exported from code-extractor.ts to preserve original import paths.

import { fileURLToPath } from "node:url"
import type { Extraction, ExtractedEntity, ExtractedRelation, KnowledgeExtractor } from "./types"
import { slugify } from "./text-hygiene"

// NB: this module lives one directory deeper than the original code-extractor.ts, so
// the relative path to node_modules gains one extra `../` to resolve identically.
const WASM_DIR = fileURLToPath(new URL("../../../node_modules/tree-sitter-wasms/out/", import.meta.url))

// All 36 grammars shipped by tree-sitter-wasms (grammar name → wasm file stem).
const GRAMMARS = [
  "bash", "c", "c_sharp", "cpp", "css", "dart", "elisp", "elixir", "elm", "embedded_template",
  "go", "html", "java", "javascript", "json", "kotlin", "lua", "objc", "ocaml", "php",
  "python", "ql", "rescript", "ruby", "rust", "scala", "solidity", "swift", "systemrdl",
  "tlaplus", "toml", "tsx", "typescript", "vue", "yaml", "zig",
] as const
type Lang = (typeof GRAMMARS)[number]
const GRAMMAR_SET = new Set<string>(GRAMMARS)

// File extension → grammar. Covers every supported language.
const EXT_TO_LANG: Record<string, Lang> = {
  sh: "bash", bash: "bash", zsh: "bash",
  c: "c", h: "c",
  cs: "c_sharp",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp", hh: "cpp",
  css: "css", scss: "css",
  dart: "dart",
  el: "elisp", emacs: "elisp",
  ex: "elixir", exs: "elixir",
  elm: "elm",
  erb: "embedded_template", ejs: "embedded_template",
  go: "go",
  html: "html", htm: "html",
  java: "java",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  json: "json",
  kt: "kotlin", kts: "kotlin",
  lua: "lua",
  m: "objc", mm: "objc",
  ml: "ocaml", mli: "ocaml",
  php: "php",
  py: "python", pyi: "python",
  ql: "ql",
  res: "rescript",
  rb: "ruby",
  rs: "rust",
  scala: "scala", sc: "scala",
  sol: "solidity",
  swift: "swift",
  rdl: "systemrdl",
  tla: "tlaplus",
  toml: "toml",
  tsx: "tsx",
  ts: "typescript", mts: "typescript", cts: "typescript",
  vue: "vue",
  yaml: "yaml", yml: "yaml",
  zig: "zig",
}

type Kind = "func" | "class" | "call" | "import"

// Generic, convention-based classification of a tree-sitter node type. Tree-sitter
// grammars vary (`function_declaration`, `function_item`, `function_definition_statement`,
// …) so we match a KEYWORD plus a DEF-SUFFIX rather than enumerate every combination.
const IMPORT_RE = /^(import|include|use|using|require|package|open|with|load)(_|$)/
const CALL_RE = /(^|_)(call|invocation|command)(_expression|_statement)?$/
const CLASS_KEY = /(^|_)(class|struct|interface|trait|enum|contract|object|protocol|module|impl|type|record|union|actor|mixin|component)(_|$)/
const FUNC_KEY = /(^|_)(function|method|func|fn|constructor|subroutine|procedure|def|getter|setter)(_|$)/
const DEF_SUFFIX = /(declaration|definition|specifier|item|signature|spec|statement|binding)/

// Outliers whose node names carry no DEF-SUFFIX keyword. NB: bare "module" is Ruby's
// `module M` namespace - but it's also Python's FILE ROOT node type, so we must never
// classify the root (handled by starting the walk at the root's children).
const EXTRA_CLASS = new Set(["class", "module", "singleton_class", "object_declaration", "protocol_declaration"])
const EXTRA_FUNC = new Set(["method", "singleton_method", "let_binding", "value_declaration", "function_declaration_left", "defun", "macro_definition"])
const EXTRA_CALL = new Set(["function_call", "member_call_expression", "scoped_call_expression", "command_call", "method_call"])

function classify(t: string): Kind | null {
  if (t === "preproc_include") return "import"
  if (IMPORT_RE.test(t)) return "import"
  if (CALL_RE.test(t) || EXTRA_CALL.has(t)) return "call"
  if ((CLASS_KEY.test(t) && DEF_SUFFIX.test(t)) || EXTRA_CLASS.has(t)) return "class"
  if ((FUNC_KEY.test(t) && DEF_SUFFIX.test(t)) || EXTRA_FUNC.has(t)) return "func"
  return null
}

// Elixir (and similar Lisp-y grammars) express definitions AS macro calls - `def`,
// `defmodule`, etc. are `call` nodes whose head identifier is the macro name.
const DEF_MACROS = new Set(["def", "defp", "defmacro", "defmacrop", "defmodule", "defprotocol", "defimpl", "defstruct", "defn", "defun", "defmethod", "defclass"])
const MODULE_MACROS = new Set(["defmodule", "defprotocol", "defimpl", "defclass"])

const C_EXTRACTED = 1.0 // call resolves to a symbol we defined here
const C_INFERRED = 0.7 // call to an unknown/external symbol

let parserInit: Promise<void> | null = null
const langCache = new Map<string, unknown>()

async function loadLang(lang: string): Promise<unknown | null> {
  try {
    const TS = (await import("web-tree-sitter")).default as any
    if (!parserInit) parserInit = TS.init()
    await parserInit
    if (!langCache.has(lang)) {
      if (!GRAMMAR_SET.has(lang)) return null
      langCache.set(lang, await TS.Language.load(WASM_DIR + `tree-sitter-${lang}.wasm`))
    }
    return langCache.get(lang)
  } catch {
    return null // grammars unavailable (e.g. compiled binary) → graceful no-op
  }
}

export class CodeExtractor implements KnowledgeExtractor {
  /** All languages this extractor can parse. */
  static languages(): readonly string[] {
    return GRAMMARS
  }

  /** Map a filename to a supported language, or null. */
  static detectLanguage(name?: string): string | null {
    if (!name) return null
    const ext = name.toLowerCase().split(".").pop() ?? ""
    return EXT_TO_LANG[ext] ?? null
  }

  /** Implements the generic extractor interface. Uses `meta.language` if given, else
   *  detects from `meta.name` (the filename). Returns empty for non-code / unknown. */
  async extract(text: string, meta?: { name?: string; language?: string }): Promise<Extraction> {
    const lang = meta?.language ?? CodeExtractor.detectLanguage(meta?.name)
    if (!lang) return { entities: [], relations: [] }
    return this.extractCode(text, lang, meta?.name ?? "source")
  }

  /** Parse one source file into code entities + relations. Returns empty (never
   *  throws) if the grammar can't load or its ABI is incompatible with the runtime. */
  async extractCode(code: string, lang: string, fileName = "source"): Promise<Extraction> {
    const Language = await loadLang(lang)
    if (!Language) return { entities: [], relations: [] }
    let tree: any
    try {
      const TS = (await import("web-tree-sitter")).default as any
      const parser = new TS()
      parser.setLanguage(Language) // throws on ABI mismatch → caught → graceful empty
      tree = parser.parse(code)
    } catch {
      return { entities: [], relations: [] }
    }

    const entities = new Map<string, ExtractedEntity>()
    const relations = new Map<string, ExtractedRelation>()
    const defined = new Set<string>() // symbol ids we actually define here

    const fileId = `file:${slugify(fileName)}`
    entities.set(fileId, { id: fileId, label: fileName, type: "FILE" })

    const symId = (name: string) => `sym:${slugify(name)}`
    const addEnt = (id: string, label: string, type: string) => {
      if (!entities.has(id)) entities.set(id, { id, label, type })
    }
    const addRel = (from: string, to: string, type: string, confidence: number) => {
      const key = `${from}|${to}|${type}`
      if (!relations.has(key)) relations.set(key, { from, to, type, confidence })
    }
    // Find a definition's name: prefer the `name` field, else a shallow DFS for the
    // first identifier-like token (skipping parameter lists), so it works across grammars.
    const IDENT_RE = /(identifier|name|word|constant|type_identifier|field_identifier)/
    const nameOf = (node: any): string | null => {
      const n = node.childForFieldName?.("name")
      if (n?.text) return n.text
      const stack: any[] = [node]
      let depth = 0
      while (stack.length && depth < 400) {
        const cur = stack.shift()
        depth++
        for (let i = 0; i < cur.namedChildCount; i++) {
          const c = cur.namedChild(i)
          if (/parameter|argument|body|block/.test(c.type)) continue
          if (IDENT_RE.test(c.type)) return c.text
          stack.push(c)
        }
      }
      return null
    }
    const lastSegment = (text: string): string | null => {
      const parts = text.split(/[.:>-]+/).filter(Boolean)
      return parts[parts.length - 1] || null
    }
    // The first identifier-like token in preorder, skipping argument subtrees - for a
    // call node that's the callee; for an Elixir def-macro that's the macro name.
    const firstIdent = (node: any): string | null => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i)
        if (/argument/.test(c.type)) continue
        if (IDENT_RE.test(c.type)) return c.text
        const deep = firstIdent(c)
        if (deep) return deep
      }
      return null
    }
    const calleeOf = (node: any): string | null => {
      const f = node.childForFieldName?.("function") || node.childForFieldName?.("name") || node.childForFieldName?.("method")
      if (f?.text) return lastSegment(f.text)
      const id = firstIdent(node)
      return id ? lastSegment(id) : null
    }
    // Elixir: name defined by a def-macro call - in its arguments, the first module
    // alias or the head identifier of the inner call (e.g. `def greet(n)` → greet).
    const elixirDefName = (node: any): string | null => {
      let scope = node
      for (let i = 0; i < node.namedChildCount; i++) if (node.namedChild(i).type === "arguments") scope = node.namedChild(i)
      for (let i = 0; i < scope.namedChildCount; i++) {
        const c = scope.namedChild(i)
        if (c.type === "alias") return c.text
        if (c.type === "call") return firstIdent(c)
        if (IDENT_RE.test(c.type)) return c.text
      }
      return null
    }

    const walk = (node: any, enclosing: string, enclosingClass: string | null) => {
      let nextEnclosing = enclosing
      let nextClass = enclosingClass
      const kind = classify(node.type)

      if (kind === "class") {
        const nm = nameOf(node)
        if (nm) {
          const id = symId(nm)
          addEnt(id, nm, "CLASS")
          defined.add(id)
          addRel(fileId, id, "defines", C_EXTRACTED)
          nextEnclosing = id
          nextClass = id
        }
      } else if (kind === "func") {
        const nm = nameOf(node)
        if (nm) {
          const id = symId(nm)
          const type = enclosingClass ? "METHOD" : "FUNCTION"
          addEnt(id, nm, type)
          defined.add(id)
          if (enclosingClass) addRel(enclosingClass, id, "has_method", C_EXTRACTED)
          else addRel(fileId, id, "defines", C_EXTRACTED)
          nextEnclosing = id
        }
      } else if (kind === "import") {
        const mod = node.text.replace(/^[^A-Za-z0-9_./@]*(import|from|use|using|require|include|package|open|with|load)\s+/i, "").split(/[\s;(){}]/)[0]?.replace(/["'`<>]/g, "")
        if (mod && mod.length > 1) {
          const id = `module:${slugify(mod)}`
          addEnt(id, mod, "MODULE")
          addRel(fileId, id, "imports", C_EXTRACTED)
        }
      } else if (kind === "call") {
        // Elixir-style: a call to a def-macro is actually a DEFINITION.
        const head = firstIdent(node)
        if (head && DEF_MACROS.has(head)) {
          const nm = elixirDefName(node)
          if (nm && nm.length > 1) {
            const id = symId(nm)
            const isMod = MODULE_MACROS.has(head)
            addEnt(id, nm, isMod ? "CLASS" : enclosingClass ? "METHOD" : "FUNCTION")
            defined.add(id)
            if (isMod) {
              addRel(fileId, id, "defines", C_EXTRACTED)
              nextClass = id
            } else if (enclosingClass) addRel(enclosingClass, id, "has_method", C_EXTRACTED)
            else addRel(fileId, id, "defines", C_EXTRACTED)
            nextEnclosing = id
          }
        } else {
          const callee = calleeOf(node)
          if (callee && callee.length > 1) {
            const id = symId(callee)
            addEnt(id, callee, "FUNCTION")
            addRel(enclosing, id, "calls", defined.has(id) ? C_EXTRACTED : C_INFERRED)
          }
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i), nextEnclosing, nextClass)
    }
    // Start at the root's CHILDREN - never classify the root itself (e.g. Python's
    // root node type is "module", which would otherwise look like a class).
    for (let i = 0; i < tree.rootNode.namedChildCount; i++) walk(tree.rootNode.namedChild(i), fileId, null)

    // Second pass: a call to a symbol that turned out to be locally defined (possibly
    // seen before its definition) is promoted to EXTRACTED confidence.
    for (const r of relations.values()) if (r.type === "calls" && defined.has(r.to)) r.confidence = C_EXTRACTED

    return { entities: [...entities.values()], relations: [...relations.values()] }
  }
}
