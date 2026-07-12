// Text-hygiene utilities: slug/clean-line normalization and web-boilerplate
// stripping. Used by the extractors and (via re-export from extract.ts) across
// the codebase. Re-exported from extract.ts to preserve original import paths.

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

// Knowledge-graph entities share the `nodes` table with principals (users/orgs/groups)
// and records. Their ids are slugs of free text, so without isolation an ingested
// document that merely MENTIONS a word matching a principal id would overwrite that
// principal's node (INSERT OR REPLACE) and silently corrupt the ACL graph. Entity ids
// live in their own namespace so the collision is impossible - and every writer AND
// resolver must agree on the scheme, so it is defined ONCE here.
export const ENTITY_PREFIX = "entity:"
export const entityId = (slug: string): string => ENTITY_PREFIX + slug

// Strip markdown emphasis / heading / blockquote / bullet noise from a line of
// (often scraped) text, so stored + returned snippets are clean prose - no `**`,
// `#`, `>` or leftover bullet markers leaking into answers.
export function cleanLine(s: string): string {
  return s
    .replace(/\*\*|__|`+/g, "") // bold / italic / code markers
    .replace(/^\s*#{1,6}\s+/, "") // heading hashes
    .replace(/^\s*>+\s*/, "") // blockquote
    .replace(/^[-*•▪◦\d.)\s]+/, "") // leading bullets / numbering
    .replace(/\s+/g, " ")
    .trim()
}

// Web boilerplate (cookie banners, nav menus, subscribe CTAs) that pollutes scraped
// pages and would otherwise become junk entities / noisy chunks. Strong multi-word
// phrases always drop; short EXACT nav tokens drop; real sentences are preserved.
const STRONG_BOILER =
  /(manage cookie consent|cookie consent|consent banner|cookie policy|privacy policy|gdpr.?compliant|opt.?out|skip to content|view preferences|subscribe now|consenting to these technologies|withdrawing consent|adversely affect certain|join our community|all our premium content|delivered straight to your inbox|post a press release|reach our audience|editorial opportunities)/i
const NAV_TOKENS =
  /^(accept|deny|subscribe|search|search\.\.\.|view preferences|view all|view all latest|see all|click here|sign in|log in|menu|home|contact us|newsletter|categories|events|resources|more|explore|explore all|explore more|applications|industries|news|search\b)$/i

export function isBoilerplate(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (STRONG_BOILER.test(t)) return true
  if (NAV_TOKENS.test(t)) return true
  return false
}

/** Drop boilerplate lines from a block of (scraped) text before chunking/extraction. */
export function stripBoilerplate(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !isBoilerplate(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}
