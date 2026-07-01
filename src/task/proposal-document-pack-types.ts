import type { DesignDocGranularity, RequiredDocument } from "./classify";

export interface DocumentPack {
  pattern: string;
  level: DesignDocGranularity;
  keywords: string[];
  designDocs: RequiredDocument[];
  testDocs: RequiredDocument[];
  evidence: string[];
  gates: string[];
}

export const LEVEL_RANK: Record<DesignDocGranularity, number> = {
  G0: 0,
  G1: 1,
  G2: 2,
  G3: 3,
  G4: 4,
  G5: 5,
};

export const RANK_LEVEL = Object.fromEntries(
  Object.entries(LEVEL_RANK).map(([level, rank]) => [rank, level]),
) as Record<number, DesignDocGranularity>;

export function doc(id: string, path: string, reason: string): RequiredDocument {
  return { id, path, reason };
}

// Japanese triggers are represented with escapes so the source stays ASCII while
// proposal text written in Japanese still classifies deterministically.
