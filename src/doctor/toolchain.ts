import {
  analyzeToolchainPin,
  loadToolchainPinDocs,
  toolchainPinMessages,
} from "../lint/toolchain-pin.ts";
import type { LintResult } from "../plan/lint.ts";

export function checkToolchainPin(repoRoot: string): LintResult {
  const result = analyzeToolchainPin(loadToolchainPinDocs(repoRoot));
  return { ok: result.ok, messages: toolchainPinMessages(result) };
}
