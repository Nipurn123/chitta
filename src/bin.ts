#!/usr/bin/env bun
// Chitta entrypoint dispatcher. One binary, three modes:
//   chitta                      → MCP stdio server (what MCP clients launch; the default)
//   chitta install [...]        → wire Chitta into AI tools (MCP config + Skill)
//   chitta ingest|query|...     → the embedded CLI
// Sub-entrypoints self-run on import, so we route by dynamic import (no eager start).
export {} // module marker (enables top-level await)

// Arg layout differs by how we're launched:
//   `bun run src/bin.ts <args>`  → argv = [bun, /path/bin.ts, ...args]   (args at index 2)
//   compiled `./chitta <args>`   → argv = [/path/chitta, ...args]        (args at index 1)
//   (the Node shim execs the compiled binary, so it hits the compiled layout too)
// Detect via whether argv[1] is a script file, then NORMALIZE process.argv to the canonical
// [exec, "chitta", ...args] so every downstream module's process.argv.slice(2) is correct.
const launchedFromScript = !!process.argv[1] && /\.(ts|js|mjs|cjs)$/.test(process.argv[1])
const userArgs = launchedFromScript ? process.argv.slice(2) : process.argv.slice(1)
process.argv = [process.argv[0], "chitta", ...userArgs]

const cmd = userArgs[0]

if (!cmd || cmd.startsWith("-")) {
  await import("./mcp/server") // bare invocation (or flags) = MCP server
} else if (cmd === "install" || cmd === "uninstall") {
  await import("./install/index")
} else {
  await import("./embedded/cli") // ingest | query | user-add | ...
}
