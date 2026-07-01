/**
 * screen-impl-pair-freeze gate — 「画面 (L2-screen) は、宣言した検証ペア (`next_pair_freeze`) が
 * 到達するまで、下流の実装完了 (`implemented_screens`) を宣言してはならない」を fail-close で担保する。
 *
 * 背景 (なぜ要るか): 画面の V-model 鎖は `L2 設計+Low-Fi mock → L10 UX refinement/High-Fi mock →
 * src/web 実装 (Phase B)` (ui-element §6 / screen-list §下流 / wireframe §4)。この段階順を機械が一切
 * 見ていなかったため、L10 (mock→UX refinement) を **すっ飛ばして** `implemented_screens` に全画面を並べ、
 * projection が `implemented=1` を立て、「Phase B 完遂」と被覆で名乗れてしまった (absence-blindness)。
 * descent-obligation は FR-L1 trace key 鎖 (L1→L3→…→L7) 専用で、画面 (PM/HM/GD) の L2→L10→impl 段階は
 * 被覆していない。本 gate はその穴を埋める。
 *
 * ルール: screen-list frontmatter が `next_pair_freeze: L<n>` を宣言し、その段階が **未到達** なのに
 * `implemented_screens` が非空 = 「いまの段階はモックなのに実装完了を宣言した」= violation。
 * 到達判定 = `docs/design/harness/L<n>-*` 設計ディレクトリに confirmed/frozen の sub-doc が実在するか。
 *
 * 純関数 (analyzeScreenImplPairFreeze) + I/O loader (loadScreenImplPairFreezeInput) を分離
 * (lint 共通様式、architecture §3.2)。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface ScreenImplPairFreezeInput {
  /** screen-list.md が存在したか (不在 = scope 0、OK)。 */
  screenDesignPresent: boolean;
  /** screen-list frontmatter `next_pair_freeze` (例 "L10")、未宣言なら null。 */
  nextPairFreeze: string | null;
  /** `implemented_screens` に列挙された画面 ID (空白/カンマ区切りを正規化)。 */
  implementedScreens: string[];
  /** next_pair_freeze 段階が到達済み (該当 layer 設計 dir に confirmed sub-doc が実在) か。 */
  pairFreezeReached: boolean;
}

export interface ScreenImplPairFreezeResult {
  ok: boolean;
  /** 実装完了として宣言された画面数。 */
  checked: number;
  /** premature に宣言された画面 ID (violation 時のみ非空)。 */
  violations: string[];
  nextPairFreeze: string | null;
  pairFreezeReached: boolean;
}

/**
 * 画面実装宣言が検証ペアの段階順を破っていないか判定する。
 * - screen 設計不在 / implemented 宣言なし → scope 0 で OK (mock 段階は正常)。
 * - next_pair_freeze 宣言があり未到達なのに implemented 宣言あり → fail-close。
 * - next_pair_freeze 到達済み → 実装宣言を許容。
 */
export function analyzeScreenImplPairFreeze(
  input: ScreenImplPairFreezeInput,
): ScreenImplPairFreezeResult {
  const { screenDesignPresent, nextPairFreeze, implementedScreens, pairFreezeReached } = input;
  const base = { nextPairFreeze, pairFreezeReached };
  if (!screenDesignPresent || implementedScreens.length === 0) {
    return { ok: true, checked: 0, violations: [], ...base };
  }
  // 実装が宣言されているが、検証ペア段階が宣言されていない or 未到達 = 段階順違反。
  if (nextPairFreeze !== null && !pairFreezeReached) {
    return {
      ok: false,
      checked: implementedScreens.length,
      violations: [...implementedScreens],
      ...base,
    };
  }
  return { ok: true, checked: implementedScreens.length, violations: [], ...base };
}

function frontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const parsed = parseYaml(content.slice(3, end));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** frontmatter or 本文に confirmed/frozen status を持つ .md が dir 配下に実在するか。 */
function hasConfirmedDoc(dirAbs: string): boolean {
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (hasConfirmedDoc(abs)) return true;
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const status = String(frontmatter(readFileSync(abs, "utf8")).status ?? "").toLowerCase();
      if (status.startsWith("confirmed") || status.startsWith("frozen")) return true;
    }
  }
  return false;
}

/** next_pair_freeze=L<n> の段階が到達済みか (該当 layer 設計 dir に confirmed sub-doc が実在)。 */
function isPairFreezeReached(repoRoot: string, nextPairFreeze: string | null): boolean {
  if (nextPairFreeze === null) return false;
  const layerMatch = nextPairFreeze.match(/^L(\d+)$/);
  if (!layerMatch) return false;
  const n = layerMatch[1];
  const designRoot = join(repoRoot, "docs", "design", "harness");
  if (!existsSync(designRoot)) return false;
  const dirRe = new RegExp(`^L${n}(?:-|$)`);
  for (const entry of readdirSync(designRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && dirRe.test(entry.name)) {
      if (hasConfirmedDoc(join(designRoot, entry.name))) return true;
    }
  }
  return false;
}

export function loadScreenImplPairFreezeInput(repoRoot: string): ScreenImplPairFreezeInput {
  const screenListPath = join(repoRoot, "docs", "design", "harness", "L2-screen", "screen-list.md");
  if (!existsSync(screenListPath)) {
    return {
      screenDesignPresent: false,
      nextPairFreeze: null,
      implementedScreens: [],
      pairFreezeReached: false,
    };
  }
  const fm = frontmatter(readFileSync(screenListPath, "utf8"));
  const nextRaw = fm.next_pair_freeze;
  const nextPairFreeze = typeof nextRaw === "string" && nextRaw.trim() ? nextRaw.trim() : null;
  const implementedRaw = fm.implemented_screens;
  const implementedScreens =
    typeof implementedRaw === "string"
      ? implementedRaw
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  return {
    screenDesignPresent: true,
    nextPairFreeze,
    implementedScreens,
    pairFreezeReached: isPairFreezeReached(repoRoot, nextPairFreeze),
  };
}

export function screenImplPairFreezeMessages(result: ScreenImplPairFreezeResult): string[] {
  const stage = result.nextPairFreeze ?? "(未宣言)";
  if (result.ok) {
    if (result.checked === 0) {
      return [`screen-impl-pair-freeze - OK (実装宣言なし = mock 段階、next_pair_freeze=${stage})`];
    }
    return [
      `screen-impl-pair-freeze - OK (implemented=${result.checked}、next_pair_freeze=${stage} 到達済)`,
    ];
  }
  return [
    `screen-impl-pair-freeze - violation: ${result.violations.length} 画面が implemented_screens で実装完了宣言されているが、検証ペア next_pair_freeze=${stage} が未到達。この段階の成果物は mock (L2 wireframe → L10 High-Fi/UX refinement) であって実装ではない。実装宣言を撤回するか ${stage} を freeze せよ。対象: ${result.violations.join(", ")}`,
  ];
}
