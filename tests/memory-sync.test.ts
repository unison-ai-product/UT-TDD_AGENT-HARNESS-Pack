import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeMemorySync,
  loadMemorySyncInput,
  memorySyncMessages,
} from "../src/lint/memory-sync.ts";
import { removeTestTree } from "./support/temp-tree.ts";

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
}

/** 単独の git repo を作り、memory ファイルの同期状態を実 git で作り分ける。 */
function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "ut-tdd-memory-sync-"));
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "user.name", "fixture"]);
  mkdirSync(join(repo, ".ut-tdd", "memory"), { recursive: true });
  return repo;
}

function writeMemory(repo: string, name: string, body: string): string {
  const rel = `.ut-tdd/memory/${name}`;
  writeFileSync(
    join(repo, rel),
    ["---", "memory_id: memory:project:x", "kind: project", 'title: "x"', "---", "", body, ""].join(
      "\n",
    ),
    "utf8",
  );
  return rel;
}

describe("memory-sync (PLAN-L7-468 PR-B)", () => {
  // U-MEMSYNC-001: AC-5 — untracked は error で検出される
  it("fails closed on an untracked shared memory file", () => {
    const repo = fixtureRepo();
    try {
      writeMemory(repo, "project-untracked.md", "commit していない引き継ぎメモ");
      const result = analyzeMemorySync(loadMemorySyncInput(repo));

      expect(result.ok).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]?.state).toBe("untracked");
      expect(result.violations[0]?.source_path).toBe(".ut-tdd/memory/project-untracked.md");
      const messages = memorySyncMessages(result);
      expect(messages.join("\n")).toContain("memory-sync - violation");
      expect(messages.join("\n")).toContain("project-untracked.md(untracked)");
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMSYNC-002: 追跡済みでも未コミット変更は error (内容が届いていない)
  it("fails closed when a tracked memory file has uncommitted changes", () => {
    const repo = fixtureRepo();
    try {
      const rel = writeMemory(repo, "project-tracked.md", "初版");
      git(repo, ["add", rel]);
      git(repo, ["commit", "-m", "add memory"]);
      expect(analyzeMemorySync(loadMemorySyncInput(repo)).violations).toHaveLength(0);

      writeMemory(repo, "project-tracked.md", "追記したが commit していない");
      const result = analyzeMemorySync(loadMemorySyncInput(repo));
      expect(result.ok).toBe(false);
      expect(result.violations[0]?.state).toBe("uncommitted-change");
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMSYNC-003: AC-5 — origin 到達で violation が 0 になる (検出が commit だけで消えない)
  it("clears the violation only once the file reaches the origin ref", () => {
    const origin = mkdtempSync(join(tmpdir(), "ut-tdd-memory-origin-"));
    const repo = fixtureRepo();
    try {
      execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { stdio: "pipe" });
      git(repo, ["remote", "add", "origin", origin]);
      const rel = writeMemory(repo, "project-shared.md", "共有される教訓");
      git(repo, ["add", rel]);
      git(repo, ["commit", "-m", "add memory"]);

      // 最初の push 前は origin ref 自体を解決できず、到達を証明できないため fail-close。
      const committed = analyzeMemorySync(loadMemorySyncInput(repo));
      expect(committed.ok).toBe(false);
      expect(committed.originResolved).toBe(false);
      expect(committed.warnings).toHaveLength(1);
      expect(committed.warnings[0]?.state).toBe("not-on-origin");
      expect(memorySyncMessages(committed).join("\n")).toContain("判定不能");

      git(repo, ["push", "origin", "main"]);
      const pushed = analyzeMemorySync(loadMemorySyncInput(repo));
      expect(pushed.ok).toBe(true);
      expect(pushed.warnings).toHaveLength(0);
      expect(pushed.shared).toBe(1);
      expect(memorySyncMessages(pushed).join("\n")).toContain("memory-sync — OK");
    } finally {
      removeTestTree(repo);
      removeTestTree(origin);
    }
  });

  // U-MEMSYNC-004: origin が解決できない環境で「すべて到達」と言わない (未評価 ≠ OK)
  it("never claims full delivery when the origin ref cannot be resolved", () => {
    const repo = fixtureRepo();
    try {
      const rel = writeMemory(repo, "project-no-origin.md", "remote が無い環境");
      git(repo, ["add", rel]);
      git(repo, ["commit", "-m", "add memory"]);

      const result = analyzeMemorySync(loadMemorySyncInput(repo));
      expect(result.originResolved).toBe(false);
      expect(result.ok).toBe(false);
      const joined = memorySyncMessages(result).join("\n");
      expect(joined).toContain("violation");
      expect(joined).toContain("判定不能");
      expect(joined).not.toContain("memory-sync — OK");
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMSYNC-006 (issue #187): 既存 memory の更新は push するまで shared にならない
  it("does not call an updated memory shared until the new content reaches origin", () => {
    const origin = mkdtempSync(join(tmpdir(), "ut-tdd-memory-origin-"));
    const repo = fixtureRepo();
    try {
      execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { stdio: "pipe" });
      git(repo, ["remote", "add", "origin", origin]);
      const rel = writeMemory(repo, "project-updated.md", "初版");
      git(repo, ["add", rel]);
      git(repo, ["commit", "-m", "add memory"]);
      git(repo, ["push", "origin", "main"]);
      expect(analyzeMemorySync(loadMemorySyncInput(repo)).shared).toBe(1);

      // 既存ファイルを更新して commit するが push しない。パスは origin に存在したまま。
      writeMemory(repo, "project-updated.md", "今日の引き継ぎへ更新した");
      git(repo, ["add", rel]);
      git(repo, ["commit", "-m", "update memory"]);

      const updated = analyzeMemorySync(loadMemorySyncInput(repo));
      expect(updated.shared).toBe(0);
      expect(updated.warnings.map((f) => f.source_path)).toEqual([rel]);
      expect(updated.warnings[0]?.state).toBe("not-on-origin");
      expect(memorySyncMessages(updated).join("\n")).not.toContain("memory-sync — OK");

      // push して初めて内容が届く。
      git(repo, ["push", "origin", "main"]);
      const pushed = analyzeMemorySync(loadMemorySyncInput(repo));
      expect(pushed.shared).toBe(1);
      expect(pushed.warnings).toHaveLength(0);
      expect(memorySyncMessages(pushed).join("\n")).toContain("memory-sync — OK");
    } finally {
      removeTestTree(repo);
      removeTestTree(origin);
    }
  });

  // U-MEMSYNC-005: 判定は純粋関数側で固定 (git を介さない境界)
  it("keeps the severity split in pure analysis: untracked errors, not-on-origin warns", () => {
    const result = analyzeMemorySync({
      originResolved: true,
      originRef: "origin/main",
      files: [
        { source_path: ".ut-tdd/memory/a.md", state: "untracked" },
        { source_path: ".ut-tdd/memory/b.md", state: "uncommitted-change" },
        { source_path: ".ut-tdd/memory/c.md", state: "not-on-origin" },
        { source_path: ".ut-tdd/memory/d.md", state: "shared" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((f) => f.source_path)).toEqual([
      ".ut-tdd/memory/a.md",
      ".ut-tdd/memory/b.md",
    ]);
    expect(result.warnings.map((f) => f.source_path)).toEqual([".ut-tdd/memory/c.md"]);
    expect(result.shared).toBe(1);
  });
});
