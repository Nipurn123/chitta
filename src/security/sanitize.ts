// Input sanitization for everything Chitta stores and later shows an LLM.
// Defends against: Trojan-Source bidi attacks (CVE-2021-42574), zero-width / hidden
// instruction smuggling, control-char format-breaking, and unbounded labels.
// Applied at INGEST (write) and again at OUTPUT (defense-in-depth — older data may
// predate sanitization or come from another writer). No dependencies.

// Character-class sources (escaped, so the file stays ASCII and unambiguous):
//  - BIDI: LRM/RLM (200E/F), the LRE/RLE/PDF/LRO/RLO block (202A-202E),
//    isolates LRI/RLI/FSI/PDI (2066-2069). Make text render/parse != how it reads.
const BIDI_SRC = "\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069"
//  - Zero-width / invisible format chars used to smuggle hidden instructions:
//    ZWSP/ZWNJ/ZWJ (200B-200D), word-joiner + invisible operators (2060-2064),
//    BOM/ZWNBSP (FEFF), soft hyphen (00AD).
const ZERO_WIDTH_SRC = "\\u200B-\\u200D\\u2060-\\u2064\\uFEFF\\u00AD"
//  - C0 + C1 control chars and DEL, but KEEP \t \n \r (09/0A/0D).
const CONTROL_SRC = "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F"

const STRIP = new RegExp(`[${BIDI_SRC}${ZERO_WIDTH_SRC}${CONTROL_SRC}]`, "g")
const DETECT = new RegExp(`[${BIDI_SRC}${ZERO_WIDTH_SRC}${CONTROL_SRC}]`) // non-global → stateless .test

export interface SanitizeOptions {
  maxLength?: number
  collapseWhitespace?: boolean
}

/** NFC-normalize, strip dangerous invisibles/controls, optionally collapse whitespace
 *  and cap length (by code point, never splitting a surrogate pair). */
export function sanitizeText(input: string | null | undefined, opts: SanitizeOptions = {}): string {
  if (input == null) return ""
  let s = String(input).normalize("NFC").replace(STRIP, "")
  if (opts.collapseWhitespace) s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
  if (opts.maxLength != null) {
    const cp = Array.from(s)
    if (cp.length > opts.maxLength) s = cp.slice(0, opts.maxLength).join("")
  }
  return s
}

export const MAX_LABEL_LEN = 256

/** Aggressive: for graph node/entity labels and record names. */
export function sanitizeLabel(input: string | null | undefined): string {
  return sanitizeText(input, { maxLength: MAX_LABEL_LEN, collapseWhitespace: true })
}

/** Gentle: for document body text headed into chunking (keep newlines/structure). */
export function sanitizeBody(input: string | null | undefined): string {
  return sanitizeText(input, { collapseWhitespace: false })
}

/** True if the input carried any dangerous invisible/control char (for telemetry). */
export function hasHiddenChars(input: string): boolean {
  return DETECT.test(input)
}
