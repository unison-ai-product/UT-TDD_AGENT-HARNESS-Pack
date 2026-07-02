import { existsSync } from "node:fs";
import {
  analyzeCodingRules,
  codingRulesMessages,
  loadCodingRuleDocs,
  loadCodingRulePolicy,
  loadCodingWorkflowDocs,
} from "../lint/coding-rules";
import { analyzeDddTddRules, dddTddRulesMessages, loadDddTddInputs } from "../lint/ddd-tdd-rules";
import {
  analyzeDesignLanguage,
  designLanguageMessages,
  loadDesignLanguageDocs,
} from "../lint/design-language";
import { analyzeGateConfirm, gateConfirmMessages, loadGateConfirmDocs } from "../lint/gate-confirm";
import {
  analyzeReadability,
  loadRuntimeArtifactReadabilityDocs,
  loadSystemReadabilityDocs,
  readabilityMessages,
  runtimeReadabilityMessages,
} from "../lint/readability";
import { analyzeRuleDrift, loadRuleAdapterDocs, ruleDriftMessages } from "../lint/rule-drift";
import {
  analyzeRuntimePortability,
  loadRuntimePortabilityDocs,
  runtimePortabilityMessages,
} from "../lint/runtime-portability";

export function checkCodingRules(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["coding-rules - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeCodingRules(
      loadCodingRuleDocs(repoRoot),
      loadCodingRulePolicy(repoRoot),
      loadCodingWorkflowDocs(repoRoot),
    );
    return { messages: codingRulesMessages(r), ok: r.ok };
  } catch {
    return { messages: ["coding-rules — violation: TS coding rule lint could not run"], ok: false };
  }
}

export function checkDesignLanguage(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["design-language - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeDesignLanguage(loadDesignLanguageDocs(repoRoot));
    return { messages: designLanguageMessages(r), ok: r.ok };
  } catch {
    return { messages: ["design-language - violation: design docs could not be read"], ok: false };
  }
}

export function checkDddTddRules(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["ddd-tdd-rules - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeDddTddRules(loadDddTddInputs(repoRoot));
    return { messages: dddTddRulesMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["ddd-tdd-rules - violation: DDD/TDD strictness lint could not run"],
      ok: false,
    };
  }
}

export function checkRuleDrift(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["rule-drift - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeRuleDrift(loadRuleAdapterDocs(repoRoot));
    return { messages: ruleDriftMessages(r), ok: r.ok };
  } catch {
    return { messages: ["rule-drift - violation: adapter rule docs could not be read"], ok: false };
  }
}

export function checkRuntimePortability(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["runtime-portability - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeRuntimePortability(loadRuntimePortabilityDocs(repoRoot));
    return { messages: runtimePortabilityMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["runtime-portability - violation: TS/Bun/Node portability lint could not run"],
      ok: false,
    };
  }
}

export function checkGateConfirm(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["gate-confirm - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeGateConfirm(loadGateConfirmDocs(repoRoot));
    return { messages: gateConfirmMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["gate-confirm - violation: gate-design/doc frontmatter could not be read"],
      ok: false,
    };
  }
}

export function checkReadability(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["readability - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeReadability(loadSystemReadabilityDocs(repoRoot));
    return { messages: readabilityMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return { messages: ["readability — ⚠ prose docs を読めない"], ok: false };
  }
}

/**
 * Expanded mojibake guard for generated runtime artifacts outside docs/
 * (PLAN-L7-69): .ut-tdd/audit/** markdown and .ut-tdd/handover/** JSON
 * (cross-agent provider payloads included). Fail-open on absence — a fresh
 * repo with no runtime artifacts has nothing to corrupt — and fail-close on
 * any mojibake marker so a corrupted handover/audit/provider-JSON cannot pass
 * silently. repo root unreadable is fail-close.
 */
export function checkRuntimeReadability(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return {
      messages: ["runtime-readability - violation: repo root could not be read"],
      ok: false,
    };
  }
  try {
    const r = analyzeReadability(loadRuntimeArtifactReadabilityDocs(repoRoot));
    return { messages: runtimeReadabilityMessages(r), ok: r.ok };
  } catch {
    return { messages: ["runtime-readability — ⚠ .ut-tdd artifacts を読めない"], ok: false };
  }
}
