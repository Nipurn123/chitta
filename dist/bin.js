#!/usr/bin/env bun
// Thin launcher: the package ships its TypeScript source and runs on Bun, which executes
// TS natively - so the published bin defers to the real dispatcher instead of carrying a
// pre-bundled copy that can (and once did) go stale relative to src/.
import("../src/bin.ts")
