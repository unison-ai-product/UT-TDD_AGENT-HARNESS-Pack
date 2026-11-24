/**
 * ゼロトラストダウンロード原則の静的 lint (issue #1741) — Red 段の stub。
 * 契約: docs/design/harness/L6-function-design/zero-trust-download-lint.md
 * 実装は Green PR。Finding / 結果を返す関数は throw、スカラー・parse は oracle を通さない定数を返す。
 */

export type ScanKind = "workflow" | "shell" | "powershell" | "batch" | "markdown";
export type ZeroTrustSeverity = "advisory" | "fail-close";

export interface ScanSource {
  path: string;
  text: string;
}

export interface CommandLine {
  path: string;
  line: number;
  text: string;
}

export interface Finding {
  path: string;
  rule: string;
  subject: string;
  line: number;
}

export interface ZeroTrustBaselineEntry {
  path: string;
  rule: string;
  subject: string;
  count: number;
}

export interface ZeroTrustBaseline {
  entries: ZeroTrustBaselineEntry[];
}

export interface ZeroTrustInput {
  sources: readonly ScanSource[];
  baseline: ZeroTrustBaseline;
  previousBaseline: ZeroTrustBaseline | null;
  mergeBaseMeasures: ZeroTrustBaseline | null;
  severity: ZeroTrustSeverity;
}

export interface ZeroTrustResult {
  ok: boolean;
  findings: Array<{ path: string; rule: string; subject: string; reason: string }>;
  summary: string;
}

export const ZERO_TRUST_SEVERITY: ZeroTrustSeverity = "advisory";

export function classifyScanTarget(_path: string): ScanKind | null {
  return null;
}

export function extractCommands(_source: ScanSource): CommandLine[] {
  throw new Error("not implemented: extractCommands (#1741 Green)");
}

export function checkInstallCommands(_file: ScanSource): Finding[] {
  throw new Error("not implemented: checkInstallCommands (#1741 Green)");
}

export function checkFetchAndExecute(_file: ScanSource): Finding[] {
  throw new Error("not implemented: checkFetchAndExecute (#1741 Green)");
}

export function analyzeZeroTrustDownload(_input: ZeroTrustInput): ZeroTrustResult {
  throw new Error("not implemented: analyzeZeroTrustDownload (#1741 Green)");
}

export function parseZeroTrustBaseline(_sourceText: string): ZeroTrustBaseline | null {
  return null;
}
