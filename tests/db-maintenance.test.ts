import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maybeVacuumHarnessDb } from "../src/state-db/db-maintenance.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { removeTestTree } from "./support/temp-tree.ts";

/**
 * Stop ごとの rebuild (delete+reinsert churn) を人工生成する。VACUUM/auto_vacuum を明示的に
 * 走らせない限り、削除されたページは freelist として file 内に残る (issue #118 実測どおり)。
 */
function churnDb(dbPath: string, repoRoot: string): void {
  const db = openHarnessDb(dbPath, { repoRoot });
  try {
    db.exec("CREATE TABLE churn (id INTEGER PRIMARY KEY, payload TEXT)");
    const insert = db.prepare("INSERT INTO churn (id, payload) VALUES (?, ?)");
    const payload = "x".repeat(2000);
    db.exec("BEGIN");
    for (let i = 0; i < 3000; i += 1) insert.run(i, payload);
    db.exec("COMMIT");
    // SQLite の b-tree は削除された行がページを完全に空にしない限りページを freelist へ
    // 戻さない (page merge は lazy)。連続範囲を末尾から削ることでページ丸ごとを空にし、
    // 実測どおり freelist を確実に作る (単純な id%2 削除では freelist_count が 0 のままだった)。
    db.exec("DELETE FROM churn WHERE id > 500");
  } finally {
    db.close();
  }
}

describe("harness.db maintenance (PLAN-L7-457, issue #118)", () => {
  it("U-DBVAC-1: VACUUM runs and shrinks the file when freelist exceeds the injected threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-dbvac-run-"));
    try {
      const dbPath = join(root, ".ut-tdd", "harness.db");
      churnDb(dbPath, root);
      const beforeStatBytes = statSync(dbPath).size;

      const result = maybeVacuumHarnessDb(dbPath, {
        repoRoot: root,
        minFreelistBytes: 4096,
        freelistRatio: 0,
      });

      expect(result.ran).toBe(true);
      expect(result.beforeBytes).toBe(beforeStatBytes);
      expect(result.afterBytes).toBeDefined();
      expect(result.afterBytes as number).toBeLessThan(beforeStatBytes);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(statSync(dbPath).size).toBe(result.afterBytes);
      expect(result.warning).toBeUndefined();
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBVAC-2: freelist below the (default) threshold leaves the file untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-dbvac-noop-"));
    try {
      const dbPath = join(root, ".ut-tdd", "harness.db");
      churnDb(dbPath, root);
      const beforeStatBytes = statSync(dbPath).size;

      // 既定閾値 (64MiB / 25%) は数MBのテスト churn を大きく上回るため発火しない。
      const result = maybeVacuumHarnessDb(dbPath, { repoRoot: root });

      expect(result.ran).toBe(false);
      expect(result.warning).toBeUndefined();
      expect(result.beforeBytes).toBeUndefined();
      expect(statSync(dbPath).size).toBe(beforeStatBytes);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-DBVAC-3: a lock held by another connection fails open with a warning instead of throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-dbvac-lock-"));
    try {
      const dbPath = join(root, ".ut-tdd", "harness.db");
      churnDb(dbPath, root);

      const blocker = openHarnessDb(dbPath, { repoRoot: root });
      blocker.exec("BEGIN IMMEDIATE");
      try {
        expect(() =>
          maybeVacuumHarnessDb(dbPath, {
            repoRoot: root,
            minFreelistBytes: 4096,
            freelistRatio: 0,
          }),
        ).not.toThrow();
        const result = maybeVacuumHarnessDb(dbPath, {
          repoRoot: root,
          minFreelistBytes: 4096,
          freelistRatio: 0,
        });
        expect(result.ran).toBe(false);
        expect(result.warning).toBeTruthy();
      } finally {
        blocker.exec("COMMIT");
        blocker.close();
      }
    } finally {
      removeTestTree(root);
    }
  });

  it("a missing harness.db is a no-op (no warning, ran=false)", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-dbvac-missing-"));
    try {
      const dbPath = join(root, ".ut-tdd", "harness.db");
      expect(existsSync(dbPath)).toBe(false);
      expect(maybeVacuumHarnessDb(dbPath, { repoRoot: root })).toEqual({ ran: false });
    } finally {
      removeTestTree(root);
    }
  });
});
