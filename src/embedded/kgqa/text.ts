// Low-level text/vector helpers shared across the KGQA paths.

export function cosine(a: number[], b: number[]): number {
  let d = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    d += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

export const stem = (s: string) => s.toLowerCase().replace(/(ing|ed|es|s)$/, "")
