# Media assets

Programmatically generated from Chitta's **real** knowledge graph - no design tool, no
manual editing, no browser.

- `chitta-graph.mp4` / `chitta-graph.gif` - a rotating 3D render of the live graph
  (`dashboard/data/graph.json`): 285 concepts, 291 relationships, colored by entity type
  (concept / org / acronym / product / person / place / activity), sized by degree, with
  labeled hubs (Elon Musk, OpenAI, Google, Microsoft, Anthropic, 100XPROMPT, …).
- `chitta-graph-1.png`, `chitta-graph-2.png` - stills.

## Reproduce

Needs `bun`, `rsvg-convert` (librsvg), and `ffmpeg`.

```bash
# 0) (optional) refresh data from your live context.db
bun run dashboard/scripts/export.ts

# 1) render SVG frames (pure Bun: 3D force layout -> SVG with real <text> labels)
bun run tools/render-graph.ts /tmp/g 96

# 2) rasterize SVG -> PNG
for s in /tmp/g/f*.svg; do rsvg-convert -w 1280 -h 800 "$s" -o "${s%.svg}.png"; done

# 3) encode
ffmpeg -y -framerate 24 -i /tmp/g/f%04d.png -c:v libx264 -pix_fmt yuv420p -crf 19 docs/assets/chitta-graph.mp4
ffmpeg -y -i /tmp/g/f%04d.png -vf "fps=16,scale=760:-1:flags=lanczos,palettegen" /tmp/pal.png
ffmpeg -y -i /tmp/g/f%04d.png -i /tmp/pal.png -lavfi "fps=16,scale=760:-1:flags=lanczos[x];[x][1:v]paletteuse" docs/assets/chitta-graph.gif
```
