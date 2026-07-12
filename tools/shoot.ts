// Render an HTML file (or URL) in a REAL headless Chromium and screenshot it after the page
// settles — for verifying / capturing canvas UIs (like the interactive graph) that static
// thumbnailers (QuickLook) can't render because they never run the animation loop.
//
//   bun run tools/shoot.ts <input.html|url> <output.png> [waitMs] [width] [height]
//
// Needs: bun add -d playwright && bunx playwright install chromium
import { chromium } from "playwright"
import { resolve } from "node:path"

const [input, output, waitMs = "2800", w = "1280", h = "820"] = process.argv.slice(2)
if (!input || !output) {
  console.error("usage: bun run tools/shoot.ts <input.html|url> <output.png> [waitMs] [w] [h]")
  process.exit(1)
}
const url = /^https?:\/\//.test(input) ? input : "file://" + resolve(input)

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: Number(w), height: Number(h) },
  deviceScaleFactor: 2,
})
await page.goto(url, { waitUntil: "load" })
await page.waitForTimeout(Number(waitMs)) // let the force simulation settle
await page.screenshot({ path: output })
await browser.close()
console.log(`shot → ${output}`)
