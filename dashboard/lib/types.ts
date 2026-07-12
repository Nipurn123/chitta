// Shape of the exported context graph (produced by scripts/export.ts).

export interface Entity {
  id: string;
  label: string;
  type: string;
  degree: number;
}

export interface Relation {
  from: string;
  to: string;
  type: string;
  weight: number;
  confidence: number;
  live: boolean;
  validAt: number | null;
  createdAt: number;
}

export interface RecordNode {
  id: string;
  name: string;
  connector: string;
  mentions: number;
}

export interface VChunk {
  id: string;
  vrid: string;
  record: string;
  preview: string;
  idx: number;
  x: number;
  y: number;
  z: number;
}

export interface VectorData {
  dim: number;
  count: number;
  vecEnabled: boolean;
  ann: string;
  explained: number[];
  chunks: VChunk[];
  sim: number[][];
  knn: { j: number; s: number }[][];
}

export interface GraphData {
  meta: {
    db: string;
    generatedAt: string;
    dbBytes: number;
    vecEnabled: boolean;
    counts: {
      nodes: number;
      edges: number;
      entities: number;
      relations: number;
      records: number;
      chunks: number;
      mentions: number;
      liveRelations: number;
      supersededRelations: number;
      predicates: number;
    };
  };
  nodesByColl: { coll: string; n: number }[];
  edgesByLabel: { label: string; n: number }[];
  entityTypes: { type: string; n: number }[];
  entities: Entity[];
  relations: Relation[];
  records: RecordNode[];
  users: { id: string; [k: string]: unknown }[];
  orgs: { id: string; [k: string]: unknown }[];
  mentions: { record: string; entity: string }[];
  permissions: { principal: string; record: string }[];
  belongsTo: { src: string; dst: string }[];
  vectors: VectorData;
}

export const TYPE_COLORS: Record<string, string> = {
  CONCEPT: "#7c9cff",
  ACRONYM: "#5eead4",
  ORG: "#f0abfc",
  PRODUCT: "#fbbf77",
  PERSON: "#fca5a5",
  ACTIVITY: "#86efac",
  RECORD: "#cdd3e0",
  DEFAULT: "#9aa3b2",
};
export const typeColor = (t: string) => TYPE_COLORS[t] ?? TYPE_COLORS.DEFAULT;
