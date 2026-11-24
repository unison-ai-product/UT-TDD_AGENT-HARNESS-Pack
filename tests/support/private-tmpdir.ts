import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { removeTestTree } from "./temp-tree.ts";

const TMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;

/**
 * 呼んだテストが終わるまで `os.tmpdir()` を、そのテスト専用の空の一時ルートへ向け、その root を返す。
 * 終了時 (失敗時も) に環境変数を戻して root を消す。テスト本体の字下げを変えずに使える。
 *
 * 別のテストファイルは別 worker で並行に走り、同じ OS 一時ディレクトリへ `ut-tdd-vitest-*` を作る。
 * `os.tmpdir()` を共有したままだと、「一時ルートに新しい entry が増えない」という観測や、
 * `<pid>-<ms>` で名前が決まる runner の snapshot dir が、他ファイルの生成物と衝突する (#1755)。
 * 専用ルートに閉じれば、観測も衝突も自分のテストの中だけで決まる。
 */
export function usePrivateTmpdir(): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-private-tmp-"));
  const saved = TMP_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of TMP_ENV_KEYS) process.env[key] = root;
  onTestFinished(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTestTree(root);
  });
  return root;
}
