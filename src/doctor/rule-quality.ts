import { existsSync } from "node:fs";
import {
  analyzeCodingRules,
  codingRulesMessages,
  loadCodingRuleDocs,
  loadCodingRulePolicy,
  loadCodingWorkflowDocs,
} from "../lint/coding-rules.ts";
import {
  analyzeDddTddRules,
  dddTddRulesMessages,
  loadDddTddInputs,
} from "../lint/ddd-tdd-rules.ts";
import {
  analyzeDesignLanguage,
  designLanguageMessages,
  loadDesignLanguageDocs,
} from "../lint/design-language.ts";
import {
  analyzeGateConfirm,
  gateConfirmMessages,
  loadGateConfirmDocs,
} from "../lint/gate-confirm.ts";
import {
  analyzeGateIdFormat,
  gateIdFormatMessages,
  loadGateIdFormatInput,
} from "../lint/gate-id-format.ts";
import {
  analyzeModelIdDocDrift,
  loadModelIdDocDriftTexts,
  modelIdDocDriftMessages,
} from "../lint/model-id-doc-drift.ts";
import {
  analyzeArtifacts,
  loadRuntimeArtifactReadabilityDocs,
  loadSystemReadabilityDocs,
  readabilityMessages,
  runtimeReadabilityMessages,
} from "../lint/readability.ts";
import {
  analyzeHookParity,
  analyzeRuleDrift,
  hookParityMessages,
  loadClaudeHookSettings,
  loadRuleAdapterDocs,
  ruleDriftMessages,
} from "../lint/rule-drift.ts";
import {
  analyzeRuntimePortability,
  loadRuntimePortabilityDocs,
  runtimePortabilityMessages,
} from "../lint/runtime-portability.ts";
import {
  analyzeSecretScan,
  loadSystemSecretScanArtifacts,
  secretScanMessages,
} from "../lint/secret-scan.ts";

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
    const docs = loadRuleAdapterDocs(repoRoot);
    const r = analyzeRuleDrift(docs);
    // marker の有無だけでは「node と書いてあるが引数や event が実体と違う」drift を拾えない。
    // hook 記載と settings.json の等価性そのものを doctor の判定へ含める (Issue #322)。
    const parity = analyzeHookParity({
      claudeRuntimeDoc: docs.claudeRuntime,
      settingsJson: loadClaudeHookSettings(repoRoot),
    });
    return {
      messages: [...ruleDriftMessages(r), ...hookParityMessages(parity)],
      ok: r.ok && parity.ok,
    };
  } catch {
    return { messages: ["rule-drift - violation: adapter rule docs could not be read"], ok: false };
  }
}

export function checkModelIdDocDrift(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["model-id-doc-drift - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeModelIdDocDrift(loadModelIdDocDriftTexts(repoRoot));
    return { messages: modelIdDocDriftMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["model-id-doc-drift - violation: L6 doc model-id scan could not run"],
      ok: false,
    };
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

export function checkGateIdFormat(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["gate-id-format - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeGateIdFormat(loadGateIdFormatInput(repoRoot));
    return { messages: gateIdFormatMessages(r), ok: r.ok };
  } catch {
    return {
      messages: ["gate-id-format - violation: gate docs or evidence manifests could not be read"],
      ok: false,
    };
  }
}

export function checkReadability(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["readability - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeArtifacts(loadSystemReadabilityDocs(repoRoot));
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
    const r = analyzeArtifacts(loadRuntimeArtifactReadabilityDocs(repoRoot));
    return { messages: runtimeReadabilityMessages(r), ok: r.ok };
  } catch {
    return { messages: ["runtime-readability — ⚠ .ut-tdd artifacts を読めない"], ok: false };
  }
}

export function checkSecretScan(repoRoot: string): { messages: string[]; ok: boolean } {
  if (!existsSync(repoRoot)) {
    return { messages: ["secret-scan - violation: repo root could not be read"], ok: false };
  }
  try {
    const r = analyzeSecretScan(loadSystemSecretScanArtifacts(repoRoot));
    return { messages: secretScanMessages(r), ok: r.checked > 0 && r.ok };
  } catch {
    return { messages: ["secret-scan — violation: secret scan artifacts を読めない"], ok: false };
  }
}
