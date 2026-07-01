import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fmValue, normalizePath } from "./shared";

export interface PlaceholderDepsDoc {
  path: string;
  status: string;
  text: string;
}

export interface PlaceholderDepsViolation {
  path: string;
  line: number;
  detail: string;
}

export interface PlaceholderDepsResult {
  checked: number;
  violations: PlaceholderDepsViolation[];
  /** 型① spec back-fill (waiting_layer = 設計層 L1-L6) の検出数 (情報、非違反)。 */
  specBackfillWaits: number;
  /** 型② impl-state (waiting_layer = L7) の active doc 違反数。 */
  implStateWaits: number;
  ok: boolean;
}

const ACTIVE_STATUSES = new Set(["", "confirmed", "completed"]);

/** 既知の V-model 層 (waiting_layer typo 検出用)。 */
const KNOWN_LAYERS = new Set(
  Array.from({ length: 15 }, (_, i) => `L${i}`), // L0..L14
);
/** 型① = 設計層待ち (spec back-fill)。これ以外で waiting_layer=L7 が型② (impl-state)。 */
const DESIGN_WAIT_LAYERS = new Set(["L1", "L2", "L3", "L4", "L5", "L6"]);

function walkMarkdown(root: string, repoRoot: string): PlaceholderDepsDoc[] {
  if (!existsSync(root)) return [];
  const docs: PlaceholderDepsDoc[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      docs.push(...walkMarkdown(full, repoRoot));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const text = readFileSync(full, "utf8");
    docs.push({
      path: normalizePath(relative(repoRoot, full)),
      status: fmValue(text, "status") ?? "",
      text,
    });
  }
  return docs;
}

export function loadPlaceholderDepsDocs(root = process.cwd()): PlaceholderDepsDoc[] {
  return [
    ...walkMarkdown(join(root, "docs", "design", "harness"), root),
    ...walkMarkdown(join(root, "docs", "test-design", "harness"), root),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * placeholder_deps の waiting_layer 2 類型 (IMP-107、physical-data §8 / A-85 I-3) を認識して検査する。
 *  - 型② **impl-state** (`waiting_layer = L7`): テスト設計は書けているが検証対象が impl で materialize。
 *    active doc に残るのは違反 (repo は L7 = impl 段階に到達済 → 解消されるべき)。**hard-fail** (既存挙動)。
 *  - 型① **spec back-fill** (`waiting_layer = 設計層 L1-L6`): 上位仕様確定待ちで対テスト設計を*書けない*。
 *    item 単位の正当な carry でありうる (band freeze ≠ item spec 確定)。**ここでは hard-fail しない**
 *    (検出数のみ surface)。型①の threshold (impl 着地後の未 discharge = 違反) は `descent-obligation`
 *    lint の impl-ahead 検査が defer ledger として正本担当する (重複させない、false-positive 回避)。
 *  - 未知 `waiting_layer` (L0-L14 外) は typo の疑いで **hard-fail**。
 *  - 「dedicated placeholder_deps doctor rule is not implemented」の旧記述は **hard-fail** (既存)。
 */
export function analyzePlaceholderDeps(docs: PlaceholderDepsDoc[]): PlaceholderDepsResult {
  const violations: PlaceholderDepsViolation[] = [];
  let checked = 0;
  let specBackfillWaits = 0;
  let implStateWaits = 0;
  for (const doc of docs) {
    if (!ACTIVE_STATUSES.has(doc.status.toLowerCase())) continue;
    checked += 1;
    const lines = doc.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (/\bplaceholder_deps\b/i.test(line)) {
        const waitMatch = line.match(/\bwaiting_layer\s*[:=]\s*"?(L\d+)\b/i);
        if (waitMatch) {
          const layer = waitMatch[1].toUpperCase();
          if (!KNOWN_LAYERS.has(layer)) {
            violations.push({
              path: doc.path,
              line: index + 1,
              detail: `placeholder_deps waiting_layer ${layer} is not a known V-model layer (L0-L14) — typo?`,
            });
          } else if (layer === "L7") {
            implStateWaits += 1;
            violations.push({
              path: doc.path,
              line: index + 1,
              detail:
                "active design/test-design still contains L7 (impl-state) waiting placeholder_deps",
            });
          } else if (DESIGN_WAIT_LAYERS.has(layer)) {
            // 型① spec back-fill: 検出のみ (threshold は descent-obligation impl-ahead が担当)。
            specBackfillWaits += 1;
          }
        }
      }
      if (/dedicated\s+`?placeholder_deps`?\s+doctor rule is (?:not |未)?implemented/i.test(line)) {
        violations.push({
          path: doc.path,
          line: index + 1,
          detail:
            "active design/test-design claims placeholder_deps doctor rule is not implemented",
        });
      }
    }
  }
  return { checked, violations, specBackfillWaits, implStateWaits, ok: violations.length === 0 };
}

export function placeholderDepsMessages(result: PlaceholderDepsResult): string[] {
  if (result.ok) {
    // 型② (L7 impl-state) を hard-fail で被覆。型① (spec back-fill) は検出のみで threshold は
    // descent-obligation が担当 = 「green = 完全 fail-close」の誤読を防ぐため coverage を明示 (IMP-107)。
    return [
      `placeholder-deps - OK (checked=${result.checked}, L7 impl-state waits=0、spec-backfill waits=${result.specBackfillWaits} [threshold=descent-obligation impl-ahead])`,
    ];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((v) => `${v.path}:${v.line}`)
    .join(", ");
  return [
    `placeholder-deps - violation: unresolved placeholder_deps ${result.violations.length}件 (${sample})`,
  ];
}
