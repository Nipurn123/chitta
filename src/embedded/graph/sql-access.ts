// Tiny SQL-access seam shared by the provider's decomposed query modules. The
// provider passes itself (its `rows` + `ph` helpers over bun:sqlite) so the
// permission-path and knowledge-graph functions stay pure of any class state.

export interface SqlAccess {
  /** Run `sql` with positional params, return all rows typed as T[]. */
  rows<T = any>(sql: string, params: unknown[]): T[]
  /** Build a comma-joined run of `n` positional placeholders ("?,?,?"). */
  ph(n: number): string
}

export const COMPLETED = "COMPLETED"
export type Pair = { rid: string; vid: string | null }
