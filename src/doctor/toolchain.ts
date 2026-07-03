import {
  analyzeToolchainPin,
  loadToolchainPinDocs,
  toolchainPinMessages,
} from "../lint/toolchain-pin";
import type { LintResult } from "../plan/lint";

export function checkToolchainPin(repoRoot: string): LintResult {
  const result = analyzeToolchainPin(loadToolchainPinDocs(repoRoot));
  return { ok: result.ok, messages: toolchainPinMessages(result) };
}
