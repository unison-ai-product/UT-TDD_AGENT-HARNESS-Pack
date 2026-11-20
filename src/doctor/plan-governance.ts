import { existsSync } from "node:fs";
import {
  analyzePropagation,
  loadPropagationDocs,
  propagationMessages,
} from "../lint/propagation.ts";
import {
  analyzeTestDesignNaming,
  loadTestDesignDocs,
  testDesignNamingMessages,
} from "../lint/test-design-naming.ts";
import { analyzePairFreeze, loadPairDocs, pairFreezeMessages } from "../vmodel/lint.ts";

export function checkPropagation(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["propagation - violation: repo root could not be read"], ok: false };
  }
  try {
    const d = loadPropagationDocs(repoRoot);
    const r = analyzePropagation(d.conceptText, d.requirementsText);
    return { messages: propagationMessages(r), ok: r.ok };
  } catch {
    return { messages: ["propagation - violation: governance docs could not be read"], ok: false };
  }
}

export function checkPairFreeze(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["pair-freeze - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzePairFreeze(loadPairDocs(repoRoot));
    return { messages: pairFreezeMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["pair-freeze - violation: design/test-design docs could not be read"],
      ok: false,
    };
  }
}

export function checkTestDesignNaming(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["test-design-naming - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeTestDesignNaming(loadTestDesignDocs(repoRoot));
    return { messages: testDesignNamingMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["test-design-naming - violation: test-design docs could not be read"],
      ok: false,
    };
  }
}
