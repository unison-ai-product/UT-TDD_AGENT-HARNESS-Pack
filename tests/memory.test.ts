import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadMemoryEntries,
  renderMemorySurface,
  selectMemoryEntries,
  writeMemoryEntry,
} from "../src/memory/index";
import { isSecretLike } from "../src/secret";
import { openHarnessDb } from "../src/state-db/index";
import { rebuildHarnessDb } from "../src/state-db/projection-writer";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "ut-tdd-memory-"));
}

function cleanupRepo(repo: string): void {
  (globalThis as { Bun?: { gc: (sync: boolean) => void } }).Bun?.gc(true);
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

describe("shared harness memory", () => {
  it("uses the shared secret detector directly", () => {
    expect(isSecretLike(`sk-${"a".repeat(20)}`)).toBe(true);
    expect(isSecretLike("planning-and-task-breakdown")).toBe(false);
  });

  // U-MEMORY-001
  it("writes authored .ut-tdd/memory markdown and reloads it deterministically", () => {
    const repo = tempRepo();
    try {
      const entry = writeMemoryEntry(repo, {
        kind: "project",
        title: "Pack target repo",
        body: "配布 Pack は unison-ai-product/UT-TDD_AGENT-HARNESS-Pack へ publish する。",
        tags: ["distribution", "github"],
        now: "2026-07-01T00:00:00.000Z",
      });

      expect(entry.memory_id).toBe("memory:project:pack-target-repo");
      expect(entry.source_path).toBe(".ut-tdd/memory/project-pack-target-repo.md");

      const loaded = loadMemoryEntries(repo);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({
        memory_id: entry.memory_id,
        kind: "project",
        title: "Pack target repo",
        tags: ["distribution", "github"],
        updated_at: "2026-07-01T00:00:00.000Z",
      });
      expect(loaded[0]?.body).toContain("UT-TDD_AGENT-HARNESS-Pack");
      expect(loaded[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      cleanupRepo(repo);
    }
  });

  // U-MEMORY-002
  it("rejects secret-like memory before writing authored files", () => {
    const repo = tempRepo();
    try {
      expect(() =>
        writeMemoryEntry(repo, {
          kind: "user",
          title: "bad token",
          body: `do not store sk-${"a".repeat(20)}`,
        }),
      ).toThrow(/secret-like/);
      expect(loadMemoryEntries(repo)).toEqual([]);
    } finally {
      cleanupRepo(repo);
    }
  });

  // U-MEMORY-003 / U-MEMORY-004
  it("projects memory entries into harness.db and renders a cross-runtime SessionStart surface", () => {
    const repo = tempRepo();
    try {
      mkdirSync(join(repo, "docs", "plans"), { recursive: true });
      writeFileSync(
        join(repo, "docs", "plans", "PLAN-L7-189-shared-harness-memory-cross-runtime.md"),
        [
          "---",
          "plan_id: PLAN-L7-189-shared-harness-memory-cross-runtime",
          "title: Shared memory fixture",
          "kind: impl",
          "layer: L7",
          "drive: agent",
          "status: confirmed",
          "created: 2026-07-01",
          "updated: 2026-07-01",
          "---",
          "",
          "# fixture",
          "",
        ].join("\n"),
        "utf8",
      );
      writeMemoryEntry(repo, {
        kind: "feedback",
        title: "Cross runtime review rule",
        body: "Claude と Codex の両方が SessionStart で同じ harness memory を読む。",
        tags: ["runtime", "review"],
        now: "2026-07-01T01:00:00.000Z",
      });

      const db = openHarnessDb(":memory:", { repoRoot: repo });
      try {
        const result = rebuildHarnessDb({
          repoRoot: repo,
          db,
          relationGraph: { nodes: [], edges: [], verificationProfiles: [], findings: [] },
          documentExports: {
            document_export_runs: [],
            document_export_datasets: [],
            document_export_artifacts: [],
            findings: [],
            actionsTaken: [],
            ok: true,
          },
          verificationEvidence: {
            verification_profiles: [],
            verification_recommendations: [],
            mcp_server_runs: [],
            external_tool_findings: [],
            findings: [],
            ok: true,
          },
        });

        expect(result.ok).toBe(true);
        expect(result.rowCounts.memory_entries).toBe(1);

        const selected = selectMemoryEntries(db, { query: "SessionStart" });
        expect(selected).toHaveLength(1);
        expect(selected[0]).toMatchObject({
          kind: "feedback",
          title: "Cross runtime review rule",
          source_path: ".ut-tdd/memory/feedback-cross-runtime-review-rule.md",
        });

        const surface = renderMemorySurface(selected);
        expect(surface).toContain("harness.db memory");
        expect(surface).toContain("shared by Claude/Codex");
        expect(surface).toContain("Cross runtime review rule");
      } finally {
        db.close();
      }
    } finally {
      cleanupRepo(repo);
    }
  });
});
