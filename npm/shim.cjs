#!/usr/bin/env node
"use strict";
// Node bin shim for `@100xprompt/chitta`. Resolves the bun-compiled binary from the matching
// optionalDependency platform package and execs it, passing argv through and INHERITING stdio
// so the MCP stdio transport (line-delimited JSON-RPC over stdin/stdout) works untouched.
// Pattern: esbuild's node-platform.ts (require.resolve into @scope/name-<os>-<arch>).
const { spawnSync } = require("child_process");
const fs = require("fs");

const SCOPE = "@100xprompt";
const NAME = "chitta";

const KNOWN = {
  "darwin-arm64": { pkg: `${SCOPE}/${NAME}-darwin-arm64`, bin: NAME },
  "darwin-x64": { pkg: `${SCOPE}/${NAME}-darwin-x64`, bin: NAME },
  "linux-x64": { pkg: `${SCOPE}/${NAME}-linux-x64`, bin: NAME },
  "linux-arm64": { pkg: `${SCOPE}/${NAME}-linux-arm64`, bin: NAME },
  "win32-x64": { pkg: `${SCOPE}/${NAME}-win32-x64`, bin: `${NAME}.exe` },
};

function binaryPath() {
  if (process.env.CHITTA_BINARY_PATH) return process.env.CHITTA_BINARY_PATH; // escape hatch
  const key = `${process.platform}-${process.arch}`;
  const entry = KNOWN[key];
  if (!entry) {
    throw new Error(`[${NAME}] unsupported platform ${key}. Supported: ${Object.keys(KNOWN).join(", ")}`);
  }
  try {
    return require.resolve(`${entry.pkg}/${entry.bin}`);
  } catch (e) {
    throw new Error(
      `[${NAME}] missing platform binary "${entry.pkg}". It installs automatically as an ` +
        `optional dependency — reinstall WITHOUT --no-optional/--omit=optional.\n${e && e.message}`
    );
  }
}

const bin = binaryPath();
try { fs.chmodSync(bin, 0o755); } catch {} // belt-and-suspenders if the exec bit was lost

const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit", windowsHide: true });
if (r.error) {
  console.error(`[${NAME}] failed to launch ${bin}: ${r.error.message}`);
  process.exit(1);
}
if (r.signal) process.kill(process.pid, r.signal);
else process.exit(r.status === null ? 1 : r.status);
