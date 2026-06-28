// Shared structural types for the KGQA subsystem.

export type Graph = {
  entities: Array<{ id: string; label: string; type: string }>
  relations: Array<{ from: string; to: string; type: string }>
}
