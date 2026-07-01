import type { DocumentPack } from "./proposal-document-pack-types";
import { DOCUMENT_PACKS_CORE } from "./proposal-document-packs-core";
import { DOCUMENT_PACKS_OPERATIONS } from "./proposal-document-packs-operations";

export { type DocumentPack, doc, LEVEL_RANK, RANK_LEVEL } from "./proposal-document-pack-types";

export const DOCUMENT_PACKS: DocumentPack[] = [
  ...DOCUMENT_PACKS_CORE,
  ...DOCUMENT_PACKS_OPERATIONS,
];

export {
  LLM_SHRINK_TERMS,
  RESEARCH_ADOPTION_BY_PATTERN,
  RESEARCH_REJECTION_KEYWORDS,
  RESEARCH_REJECTION_RULES,
} from "./proposal-research-data";
