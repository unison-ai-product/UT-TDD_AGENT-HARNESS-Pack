import type { LintResult } from "../lint/lint-result.ts";
import {
  analyzeToolchainPin,
  loadToolchainPinDocs,
  toolchainPinMessages,
} from "../lint/toolchain-pin.ts";

export function checkToolchainPin(repoRoot: string): LintResult {
  const result = analyzeToolchainPin(loadToolchainPinDocs(repoRoot));
  return { ok: result.ok, messages: toolchainPinMessages(result) };
}
