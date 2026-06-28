import { test, expect, describe } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serverEntry, writeJsonConfig, writeCodexToml, printSnippet, PKG } from "../../src/install/writers"
import { PLATFORMS } from "../../src/install/platforms"
import { installSkill, skillContent } from "../../src/install/skill"

const tmp = () => mkdtempSync(join(tmpdir(), "chitta-install-"))

describe("serverEntry dialects", () => {
  test("standard = command/args, env only when present", () => {
    expect(serverEntry("standard", {})).toEqual({ command: "npx", args: ["-y", PKG] })
    expect(serverEntry("standard", { CONTEXT_USER_ID: "a" })).toEqual({
      command: "npx", args: ["-y", PKG], env: { CONTEXT_USER_ID: "a" },
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
    expect(e.command).toEqual(["npx", "-y", PKG])
    expect(e.type).toBe("local")
    expect(e.enabled).toBe(true)
    expect(e.environment).toEqual({ X: "1" })
    expect(e.env).toBeUndefined()
  })
  test("trae is a named array entry with command array", () => {
    const e = serverEntry("trae", {}) as any
    expect(e.name).toBe("chitta")
    expect(e.command).toEqual(["npx", "-y", PKG])
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
    expect(cfg.mcpServers.chitta.command).toBe("npx")
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
    expect(t).toContain('args = ["-y", "@100xprompt/chitta"]')
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
  test("json platforms declare key+entry; toml needs neither", () => {
    for (const p of PLATFORMS) {
      if (p.format === "json" || p.format === "json-array") {
        expect(p.key, p.id).toBeTruthy()
        expect(p.entry, p.id).toBeTruthy()
      }
    }
  })
  test("every platform has a global path or is project/skill capable", () => {
    for (const p of PLATFORMS) {
      expect(Boolean(p.global || p.project || p.skillProject), p.id).toBe(true)
    }
  })
})

test("printSnippet is valid mcpServers JSON", () => {
  const snip = JSON.parse(printSnippet({ CONTEXT_USER_ID: "a" }))
  expect(snip.mcpServers.chitta.env.CONTEXT_USER_ID).toBe("a")
})
