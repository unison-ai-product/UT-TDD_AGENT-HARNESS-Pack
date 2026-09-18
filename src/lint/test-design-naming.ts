/**
 * ③テスト設計 doc の右腕層命名標準 lint (PLAN-RECOVERY-09 Step 5、再発防止)。
 *
 * docs/test-design/harness/ 直下の doc filename は `L<右腕層>-<kebab>-test-design.md`
 * (右腕層 = L7 谷 / L8 / L9 / L10 / L12 / L14) に従い、frontmatter `executed_at_layer` が
 * filename の層と一致しなければならない。左腕層命名 (旧 L1-operational / L3-acceptance) の
 * 再流入と、標準外 doc の無断追加を fail-close で防ぐ。Markdown 判定は大文字拡張子
 * (`.MD`) も対象に取り込み (`isMarkdown`)、拡張子の大文字化で検査を素通りする穴を塞ぐ。
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface TestDesignDocEntry {
  /** basename (例 `L8-integration-test-design.md`)。 */
  name: string;
  /** frontmatter `executed_at_layer` の値 (欠落は null)。 */
  executedAtLayer: string | null;
}

export interface TestDesignNamingResult {
  ok: boolean;
  checked: number;
  violations: string[];
}

const TEST_DESIGN_DIR = "docs/test-design/harness";

/** 右腕層 (谷 L7 含む)。左腕層 (L1-L6) の③命名は許可しない。 */
const RIGHT_ARM_LAYERS = new Set(["L7", "L8", "L9", "L10", "L12", "L14"]);

/**
 * 標準命名の対象外として明示許可する doc (routing 等、テスト設計本体ではない)。
 * README.md は現時点で未実在だが、index doc 追加を見込んだ forward-looking exemption。
 */
const ALLOWED_NON_STANDARD = new Set(["README.md", "proposal-document-coverage-routing.md"]);

/** 連続ハイフンを許さない kebab core (層 prefix と `-test-design.md` suffix の間)。 */
const NAMING_PATTERN = /^(L\d+)-[a-z0-9]+(?:-[a-z0-9]+)*-test-design\.md$/;

/** frontmatter (先頭 `---`...`---`) 内に限定し、trailing comment / quote を許容して値抽出。 */
function executedAtLayerOf(content: string): string | null {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const scope = fm ? fm[1] : content;
  const m = scope.match(/^executed_at_layer:\s*(\S+?)\s*(?:#.*)?$/m);
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

/** Markdown 判定は大文字拡張子 (`.MD`) も含める (case-bypass の fail-close 穴を塞ぐ)。 */
function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

export function loadTestDesignDocs(repoRoot = process.cwd()): TestDesignDocEntry[] {
  const dir = resolve(repoRoot, TEST_DESIGN_DIR);
  return readdirSync(dir)
    .filter((name) => isMarkdown(name))
    .sort()
    .map((name) => ({
      name,
      executedAtLayer: executedAtLayerOf(readFileSync(resolve(dir, name), "utf8")),
    }));
}

export function analyzeTestDesignNaming(docs: TestDesignDocEntry[]): TestDesignNamingResult {
  const violations: string[] = [];
  let checked = 0;
  for (const doc of docs) {
    if (ALLOWED_NON_STANDARD.has(doc.name)) continue;
    checked += 1;
    const m = doc.name.match(NAMING_PATTERN);
    if (!m) {
      violations.push(
        `${doc.name}: 命名標準外 (正: L<右腕層>-<kebab>-test-design.md、右腕層=${[...RIGHT_ARM_LAYERS].join("/")})`,
      );
      continue;
    }
    const layer = m[1];
    if (!RIGHT_ARM_LAYERS.has(layer)) {
      violations.push(
        `${doc.name}: 層 ${layer} は右腕層でない (③テスト設計は右腕層所属、左腕層命名は PLAN-RECOVERY-09 で撤去済み)`,
      );
      continue;
    }
    if (doc.executedAtLayer !== layer) {
      violations.push(
        `${doc.name}: frontmatter executed_at_layer=${doc.executedAtLayer ?? "(欠落)"} が filename 層 ${layer} と不一致`,
      );
    }
  }
  return { ok: violations.length === 0, checked, violations };
}

export function testDesignNamingMessages(result: TestDesignNamingResult): string[] {
  if (result.ok) {
    return [`test-design-naming - OK (checked=${result.checked}, 右腕層命名標準 準拠)`];
  }
  return [`test-design-naming - violation: ${result.violations.join("; ")}`];
}
