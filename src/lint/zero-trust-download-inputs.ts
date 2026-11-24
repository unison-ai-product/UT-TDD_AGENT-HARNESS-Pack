/**
 * ゼロトラストダウンロード lint の I/O adapter (issue #1741) — Red 段の stub。
 * 契約: docs/design/harness/L6-function-design/zero-trust-download-lint.md §8
 */
import type { ScanSource, ZeroTrustBaseline } from "./zero-trust-download.ts";

export function loadZeroTrustSources(_repoRoot: string): {
  sources: ScanSource[];
  unreadable: string[];
} {
  throw new Error("not implemented: loadZeroTrustSources (#1741 Green)");
}

export function loadPreviousZeroTrustBaseline(
  _repoRoot: string,
): { kind: "found"; baseline: ZeroTrustBaseline } | { kind: "absent" } | { kind: "unreadable" } {
  throw new Error("not implemented: loadPreviousZeroTrustBaseline (#1741 Green)");
}

export function loadZeroTrustMergeBaseMeasures(
  _repoRoot: string,
): { kind: "found"; measures: ZeroTrustBaseline } | { kind: "unreadable" } {
  throw new Error("not implemented: loadZeroTrustMergeBaseMeasures (#1741 Green)");
}

export function checkZeroTrustDownload(_repoRoot: string): { messages: string[]; ok: boolean } {
  throw new Error("not implemented: checkZeroTrustDownload (#1741 Green)");
}
