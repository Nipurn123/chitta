import { test, expect, describe } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  serverEntry, printSnippet, PKG,
  writeJsonConfig, writeYamlConfig, writeYamlFile, writeCodexToml, writeIfChanged,
  removeJsonConfig, removeYamlConfig, removeCodexToml,
} from "../../src/install/writers"
import { PLATFORMS, byId } from "../../src/install/platforms"
import { installSkill, skillContent } from "../../src/install/skill"

const tmp = () => mkdtempSync(join(tmpdir(), "chitta-install-"))

describe("serverEntry dialects", () => {
  test("standard = command/args, env only when present", () => {
    expect(serverEntry("standard", {})).toEqual({ command: "bunx", args: [PKG] })
    expect(serverEntry("standard", { CONTEXT_USER_ID: "a" })).toEqual({
      command: "bunx", args: [PKG], env: { CONTEXT_USER_ID: "a" },
    })
  })
  test("vscode adds type:stdio", () => {
    expect((serverEntry("vscode", {}) as any).type).toBe("stdio")
  })
  test("zed adds source:custom", () => {
    expect((serverEntry("zed", {}) as any).source).toBe("custom")
  })
  test("local uses combined command array + environment + enabled", () => {
    const e = serverEntry("local", { X: "1" }) as any
    expect(e.command).toEqual(["bunx", PKG])
    expect(e.type).toBe("local")
    expect(e.enabled).toBe(true)
    expect(e.environment).toEqual({ X: "1" })
    expect(e.env).toBeUndefined()
  })
  test("trae is a named array entry with command array", () => {
    const e = serverEntry("trae", {}) as any
    expect(e.name).toBe("chitta")
    expect(e.command).toEqual(["bunx", PKG])
  })
  test("goose uses cmd/args + envs (never command/env)", () => {
    const e = serverEntry("goose", { X: "1" }) as any
    expect(e).toMatchObject({ enabled: true, type: "stdio", name: "chitta", cmd: "bunx", args: [PKG], timeout: 300 })
    expect(e.envs).toEqual({ X: "1" })
    expect(e.command).toBeUndefined()
    expect(e.env).toBeUndefined()
  })
  test("continue is a named mcpServers list item with command/args", () => {
    expect(serverEntry("continue", {})).toEqual({ name: "chitta", command: "bunx", args: [PKG] })
    expect((serverEntry("continue", { X: "1" }) as any).env).toEqual({ X: "1" })
  })
})

describe("writeJsonConfig", () => {
  test("creates, preserves other servers, idempotent", () => {
    const d = tmp(); const p = join(d, "mcp.json")
    writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: "foo" } } }))
    writeJsonConfig(p, "mcpServers", serverEntry("standard", {}), false)
    writeJsonConfig(p, "mcpServers", serverEntry("standard", {}), false) // re-run
    const cfg = JSON.parse(readFileSync(p, "utf8"))
    expect(cfg.mcpServers.other).toEqual({ command: "foo" }) // preserved
    expect(cfg.mcpServers.chitta.command).toBe("bunx")
    expect(Object.keys(cfg.mcpServers)).toEqual(["other", "chitta"]) // no dup
  })
  test("array form (trae) dedups by name", () => {
    const d = tmp(); const p = join(d, "t.json")
    writeJsonConfig(p, "mcpServers", serverEntry("trae", {}), true)
    writeJsonConfig(p, "mcpServers", serverEntry("trae", {}), true)
    const cfg = JSON.parse(readFileSync(p, "utf8"))
    expect(Array.isArray(cfg.mcpServers)).toBe(true)
    expect(cfg.mcpServers.filter((e: any) => e.name === "chitta")).toHaveLength(1)
  })
  test("tolerates JSONC line comments in existing file", () => {
    const d = tmp(); const p = join(d, "c.json")
    writeFileSync(p, "{\n  // a comment\n  \"servers\": {}\n}")
    writeJsonConfig(p, "servers", serverEntry("vscode", {}), false)
    expect(JSON.parse(readFileSync(p, "utf8")).servers.chitta.type).toBe("stdio")
  })
})

describe("writeCodexToml", () => {
  test("writes table + env subtable, idempotent", () => {
    const d = tmp(); const p = join(d, "config.toml")
    writeFileSync(p, '[other]\nx = 1\n')
    writeCodexToml(p, { CONTEXT_USER_ID: "alice" })
    writeCodexToml(p, { CONTEXT_USER_ID: "alice" }) // re-run
    const t = readFileSync(p, "utf8")
    expect(t).toContain("[other]") // preserved
    expect(t.match(/\[mcp_servers\.chitta\]/g)).toHaveLength(1) // single table
    expect(t).toContain('command = "bunx"')
    expect(t).toContain('args = ["@100xprompt/chitta"]')
    expect(t).toContain("[mcp_servers.chitta.env]")
    expect(t).toContain('CONTEXT_USER_ID = "alice"')
  })
})

describe("skill", () => {
  test("bundled SKILL.md has chitta frontmatter", () => {
    expect(skillContent()).toContain("name: chitta")
  })
  test("installSkill writes <dir>/chitta/SKILL.md", () => {
    const d = tmp()
    const dst = installSkill(d)
    expect(existsSync(dst)).toBe(true)
    expect(dst.endsWith(join("chitta", "SKILL.md"))).toBe(true)
  })
})

describe("registry integrity", () => {
  test("ids unique", () => {
    const ids = PLATFORMS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  test("keyed formats declare key+entry; standalone/toml don't need a key", () => {
    for (const p of PLATFORMS) {
      if (p.format === "json" || p.format === "json-array" || p.format === "yaml") {
        expect(p.key, p.id).toBeTruthy()
        expect(p.entry, p.id).toBeTruthy()
      }
      if (p.format === "yaml-file") expect(p.entry, p.id).toBeTruthy() // no key: the block is fixed
    }
  })
  test("every platform has a global path or is project/skill capable", () => {
    for (const p of PLATFORMS) {
      expect(Boolean(p.global || p.project || p.skillProject), p.id).toBe(true)
    }
  })
  test("new tools are registered with the right dialect", () => {
    const goose = byId("goose")!
    expect(goose.format).toBe("yaml")
    expect(goose.key).toBe("extensions")
    expect(goose.entry).toBe("goose")
    const cont = byId("continue")!
    expect(cont.format).toBe("yaml-file")
    expect(cont.entry).toBe("continue")
    expect(cont.detect).toBeTruthy() // auto-detect probes the tool home, not the lazy subdir
  })
})

describe("writeYamlConfig (Goose)", () => {
  test("creates, preserves other extensions + top-level keys, idempotent", () => {
    const d = tmp(); const p = join(d, "config.yaml")
    writeFileSync(p, "# my config\nextensions:\n  developer:\n    enabled: true\n    type: builtin\nGOOSE_MODEL: gpt-4o\n")
    const b1 = writeYamlConfig(p, "extensions", serverEntry("goose", {}), false)
    const b2 = writeYamlConfig(p, "extensions", serverEntry("goose", {}), false) // re-run
    const cfg: any = Bun.YAML.parse(readFileSync(p, "utf8"))
    expect(cfg.extensions.developer).toEqual({ enabled: true, type: "builtin" }) // preserved
    expect(cfg.GOOSE_MODEL).toBe("gpt-4o") // unrelated top-level key preserved
    expect(cfg.extensions.chitta.cmd).toBe("bunx")
    expect(Object.keys(cfg.extensions)).toEqual(["developer", "chitta"]) // no dup
    expect(b1).toBeTruthy() // overwrote existing → backed up
    expect(b2).toBeNull()   // unchanged re-run → no write, no backup
  })
  test("emits tidy block YAML with no trailing whitespace", () => {
    const d = tmp(); const p = join(d, "config.yaml")
    writeYamlConfig(p, "extensions", serverEntry("goose", {}), false)
    expect(readFileSync(p, "utf8")).not.toMatch(/ +$/m)
  })
  test("refuses to clobber a non-mapping YAML file", () => {
    const d = tmp(); const p = join(d, "bad.yaml")
    writeFileSync(p, "- just\n- a\n- list\n")
    expect(() => writeYamlConfig(p, "extensions", serverEntry("goose", {}), false)).toThrow()
    expect(readFileSync(p, "utf8")).toContain("- just") // left untouched
  })
})

describe("writeYamlFile (Continue.dev standalone block)", () => {
  test("writes name/version/schema + one mcpServers entry, idempotent", () => {
    const d = tmp(); const p = join(d, "chitta.yaml")
    writeYamlFile(p, serverEntry("continue", { CONTEXT_USER_ID: "a" }))
    writeYamlFile(p, serverEntry("continue", { CONTEXT_USER_ID: "a" })) // re-run
    const block: any = Bun.YAML.parse(readFileSync(p, "utf8"))
    expect(block.schema).toBe("v1")
    expect(block.mcpServers).toHaveLength(1) // never duplicates
    expect(block.mcpServers[0]).toMatchObject({ name: "chitta", command: "bunx", args: [PKG], env: { CONTEXT_USER_ID: "a" } })
  })
})

describe("backup on overwrite", () => {
  test("writeIfChanged: first .bak, then timestamped, skips when unchanged", () => {
    const d = tmp(); const p = join(d, "f.txt")
    expect(writeIfChanged(p, "A")).toBeNull()   // new file → no backup
    const b1 = writeIfChanged(p, "B")           // overwrite → .bak holds A
    expect(b1).toBe(p + ".bak")
    expect(readFileSync(b1!, "utf8")).toBe("A")
    expect(writeIfChanged(p, "B")).toBeNull()   // unchanged → no-op, no new backup
    const b2 = writeIfChanged(p, "C")           // overwrite again → timestamped, first .bak preserved
    expect(b2).not.toBe(p + ".bak")
    expect(readFileSync(p + ".bak", "utf8")).toBe("A") // original backup intact
    expect(readFileSync(b2!, "utf8")).toBe("B")
  })
  test("writeJsonConfig backs up the prior config before merging", () => {
    const d = tmp(); const p = join(d, "mcp.json")
    writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: "x" } } }))
    const bak = writeJsonConfig(p, "mcpServers", serverEntry("standard", {}), false)
    expect(bak).toBe(p + ".bak")
    expect(JSON.parse(readFileSync(bak!, "utf8")).mcpServers.chitta).toBeUndefined() // backup is pre-merge
    expect(JSON.parse(readFileSync(p, "utf8")).mcpServers.chitta).toBeTruthy()       // live file has chitta
  })
})

describe("uninstall removes only chitta", () => {
  test("json: chitta gone, other servers kept; no-op when absent", () => {
    const d = tmp(); const p = join(d, "mcp.json")
    writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: "x" }, chitta: { command: "bunx" } } }))
    expect(removeJsonConfig(p, "mcpServers")).toBe(true)
    const cfg = JSON.parse(readFileSync(p, "utf8"))
    expect(cfg.mcpServers.other).toEqual({ command: "x" })
    expect(cfg.mcpServers.chitta).toBeUndefined()
    expect(removeJsonConfig(p, "mcpServers")).toBe(false) // already gone → no rewrite
  })
  test("json array (trae): only the chitta item is dropped", () => {
    const d = tmp(); const p = join(d, "t.json")
    writeFileSync(p, JSON.stringify({ mcpServers: [{ name: "other" }, { name: "chitta" }] }))
    expect(removeJsonConfig(p, "mcpServers")).toBe(true)
    expect(JSON.parse(readFileSync(p, "utf8")).mcpServers).toEqual([{ name: "other" }])
  })
  test("yaml (goose): chitta extension gone, others kept", () => {
    const d = tmp(); const p = join(d, "config.yaml")
    writeFileSync(p, "extensions:\n  developer:\n    enabled: true\n  chitta:\n    type: stdio\n    cmd: bunx\n")
    expect(removeYamlConfig(p, "extensions")).toBe(true)
    const cfg: any = Bun.YAML.parse(readFileSync(p, "utf8"))
    expect(cfg.extensions.developer).toEqual({ enabled: true })
    expect(cfg.extensions.chitta).toBeUndefined()
    expect(removeYamlConfig(p, "extensions")).toBe(false) // idempotent
  })
  test("toml: chitta block removed, other tables kept, idempotent", () => {
    const d = tmp(); const p = join(d, "config.toml")
    writeFileSync(p, "[other]\nx = 1\n")
    writeCodexToml(p, {})
    expect(readFileSync(p, "utf8")).toContain("[mcp_servers.chitta]")
    expect(removeCodexToml(p)).toBe(true)
    const t = readFileSync(p, "utf8")
    expect(t).toContain("[other]")
    expect(t).not.toContain("chitta")
    expect(removeCodexToml(p)).toBe(false) // nothing left to remove
  })
  test("skill removal leaves sibling skills intact", () => {
    const d = tmp()
    installSkill(d)
    mkdirSync(join(d, "other"), { recursive: true }) // a sibling skill dir
    rmSync(join(d, "chitta"), { recursive: true, force: true })
    expect(existsSync(join(d, "chitta"))).toBe(false)
    expect(existsSync(join(d, "other"))).toBe(true)
  })
})

describe("partial-failure isolation", () => {
  test("one bad target throws but the loop keeps the others", () => {
    const d = tmp()
    const fileNotDir = join(d, "afile"); writeFileSync(fileNotDir, "x")
    const targets = [
      { id: "good1", path: join(d, "a", "mcp.json") },
      { id: "bad", path: join(fileNotDir, "mcp.json") }, // parent is a file → mkdir throws
      { id: "good2", path: join(d, "b", "mcp.json") },
    ]
    const ok: string[] = []; const failed: string[] = []
    for (const t of targets) {
      // mirrors index.ts's per-tool try/catch: a throw is recorded, never aborts the run
      try { writeJsonConfig(t.path, "mcpServers", serverEntry("standard", {}), false); ok.push(t.id) }
      catch { failed.push(t.id) }
    }
    expect(ok).toEqual(["good1", "good2"]) // the others completed
    expect(failed).toEqual(["bad"])         // failure isolated
    expect(existsSync(targets[0].path)).toBe(true)
    expect(existsSync(targets[2].path)).toBe(true)
  })
})

test("printSnippet is valid mcpServers JSON", () => {
  const snip = JSON.parse(printSnippet({ CONTEXT_USER_ID: "a" }))
  expect(snip.mcpServers.chitta.env.CONTEXT_USER_ID).toBe("a")
})
