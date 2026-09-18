import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalProjectIdentityBytes } from "../src/kernel/project-identity.ts";
import {
  MEMORY_FILENAME_MAX,
  type MemoryEntry,
  memoryFileNameFor,
  memoryIdFor,
  selectMemoryEntries,
} from "../src/memory/index.ts";
import {
  compareIndexToCorpus,
  loadMemoryCorpus,
  queryMemoryEntries,
  readMemory,
  registrationReceiptFor,
  renderMemoryHealth,
  writeMemory,
} from "../src/memory/service.ts";
import { removeTestTree } from "./support/temp-tree.ts";
import { workspaceRead } from "./support/workspace-roots.ts";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "ut-tdd-memory-service-"));
}

/** 旧経路と同じ形の in-memory index。body 列は index の責務ではないので入れない。 */
function fakeIndexDb(rows: Array<{ memory_id: string; content_hash: string }>) {
  return {
    prepare(_sql: string) {
      return { all: () => rows as unknown as Record<string, unknown>[] };
    },
  };
}

/** 旧 SQL 経路 (`selectMemoryEntries`) を fixture DB で再現するための最小 stub。 */
function legacyDbFrom(entries: MemoryEntry[]) {
  const rows = entries.map((entry) => ({
    memory_id: entry.memory_id,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    tags: entry.tags.join(","),
    source_path: entry.source_path,
    updated_at: entry.updated_at,
    content_hash: entry.content_hash,
  }));
  return {
    prepare(sql: string) {
      // 旧実装は ORDER BY updated_at DESC, memory_id を SQL 側で行う。
      expect(sql).toContain("ORDER BY updated_at DESC, memory_id");
      const sorted = [...rows].sort((a, b) => {
        if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
        return a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0;
      });
      return { all: () => sorted as unknown as Record<string, unknown>[] };
    },
  };
}

function seedCorpus(repo: string): void {
  writeMemory({
    repoRoot: repo,
    input: {
      kind: "project",
      title: "Alpha lane",
      body: "Codex レーンのゴールは train 単位で与える。",
      tags: ["codex", "goal"],
      now: "2026-07-02T00:00:00.000Z",
    },
  });
  writeMemory({
    repoRoot: repo,
    input: {
      kind: "feedback",
      title: "Beta rule",
      body: "レビューは author でない family が行う。",
      tags: ["review"],
      now: "2026-07-03T00:00:00.000Z",
    },
  });
  // updated_at 同値で memory_id の tie-break が効くことを見るための 2 件。
  writeMemory({
    repoRoot: repo,
    input: {
      kind: "project",
      title: "Gamma tie",
      body: "tie-break は memory_id 昇順。",
      now: "2026-07-01T00:00:00.000Z",
    },
  });
  writeMemory({
    repoRoot: repo,
    input: {
      kind: "project",
      title: "Delta tie",
      body: "tie-break は memory_id 昇順。",
      now: "2026-07-01T00:00:00.000Z",
    },
  });
}

describe("MemoryService (PLAN-L7-468 PR-A)", () => {
  it("owns the canonical write path as well as reads", () => {
    const repo = tempRepo();
    try {
      const entry = writeMemory({
        repoRoot: repo,
        input: {
          kind: "project",
          title: "Service-owned write",
          body: "CLI は storage primitive を直接呼ばない。",
          tags: ["service"],
          now: "2026-07-29T07:00:00.000Z",
        },
      });
      expect(entry.source_path).toBe(".ut-tdd/memory/project-service-owned-write.md");
      expect(loadMemoryCorpus(repo).entries.map((candidate) => candidate.memory_id)).toContain(
        entry.memory_id,
      );
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMORY-010: AC-1 — 移植前後の等価性 (filter / 順位 / tie-break / limit)
  it("keeps the legacy DB read semantics when reading from source files", () => {
    const repo = tempRepo();
    try {
      seedCorpus(repo);
      const corpus = loadMemoryCorpus(repo);
      const legacy = legacyDbFrom(corpus.entries);

      for (const options of [
        {},
        { limit: 2 },
        { limit: 100 },
        { query: "tie-break" },
        { query: "レビュー" },
        { query: "review" },
        { query: "project" },
        { query: "no-such-token" },
        { query: "codex", limit: 1 },
      ]) {
        const fromService = queryMemoryEntries(corpus.entries, options).map((e) => e.memory_id);
        const fromLegacy = selectMemoryEntries(legacy, options).map((e) => e.memory_id);
        expect(fromService, `options=${JSON.stringify(options)}`).toEqual(fromLegacy);
      }
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMORY-011: AC-1 — 既定 limit を変えていない (recall=5 / list=20 / digest=5 の前提)
  it("keeps the legacy default limit of 8 when no limit is given", () => {
    const entries: MemoryEntry[] = Array.from({ length: 12 }, (_, index) => ({
      memory_id: `memory:project:e${String(index).padStart(2, "0")}`,
      kind: "project" as const,
      title: `e${index}`,
      body: "x",
      tags: [],
      source_path: `.ut-tdd/memory/project-e${index}.md`,
      updated_at: "2026-07-01T00:00:00.000Z",
      content_hash: `hash${index}`,
    }));
    expect(queryMemoryEntries(entries)).toHaveLength(8);
    expect(selectMemoryEntries(legacyDbFrom(entries))).toHaveLength(8);
  });

  // U-MEMORY-012: AC-3 — 破損 1 件で全件読みを落とさない (欠陥 5 の回帰)
  it("isolates a single malformed memory file instead of failing the whole read", () => {
    const repo = tempRepo();
    try {
      seedCorpus(repo);
      // frontmatter を持たないファイル = 2026-07-28 に db rebuild を 3m28s で止めた形。
      writeFileSync(
        join(repo, ".ut-tdd", "memory", "project-broken.md"),
        "frontmatter がない手書きメモ\n",
        "utf8",
      );

      const corpus = loadMemoryCorpus(repo);
      expect(corpus.entries).toHaveLength(4);
      expect(corpus.findings).toHaveLength(1);
      expect(corpus.findings[0]?.source_path).toBe(".ut-tdd/memory/project-broken.md");
      expect(corpus.findings[0]?.reason).toMatch(/frontmatter is required/);

      const result = readMemory({ repoRoot: repo });
      expect(result.entries.length).toBeGreaterThan(0);
      expect(renderMemoryHealth(result)).toContain(
        "memory unreadable: .ut-tdd/memory/project-broken.md",
      );
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMORY-013: AC-2 — index を開けなくても正本から返し、degraded を可視化する
  it("returns entries from source files and marks the index unavailable when no index is given", () => {
    const repo = tempRepo();
    try {
      seedCorpus(repo);
      const result = readMemory({ repoRoot: repo });
      expect(result.entries).toHaveLength(4);
      expect(result.freshness).toBe("index-unavailable");
      const health = renderMemoryHealth(result);
      expect(health).toContain("memory index index-unavailable");
      expect(health).toContain("正本ファイルから読み出した");
      // 「exit 0 かつ完全無出力」で degraded を隠さないこと。
      expect(health.trim().length).toBeGreaterThan(0);
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMORY-014: AC-2 — index の読み出しが throw しても読み出しは成立する (lock 相当)
  it("survives an index that throws on read, as a locked harness.db does", () => {
    const repo = tempRepo();
    try {
      seedCorpus(repo);
      const lockedIndex = {
        prepare(_sql: string) {
          return {
            all(): Record<string, unknown>[] {
              throw new Error("database is locked");
            },
          };
        },
      };
      const result = readMemory({ repoRoot: repo, db: lockedIndex });
      expect(result.entries).toHaveLength(4);
      expect(result.freshness).toBe("index-unavailable");
      expect(result.freshness_reason).toMatch(/database is locked/);
      expect(renderMemoryHealth(result)).toContain("database is locked");
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMORY-015: AC-4 (挙動側) — content_hash 照合で stale / out-of-band 変更を検出する
  it("detects a stale index by content hash instead of trusting it silently", () => {
    const repo = tempRepo();
    try {
      seedCorpus(repo);
      const corpus = loadMemoryCorpus(repo);
      const fresh = corpus.entries.map((entry) => ({
        memory_id: entry.memory_id,
        content_hash: entry.content_hash,
      }));

      expect(readMemory({ repoRoot: repo, db: fakeIndexDb(fresh) }).freshness).toBe("fresh");

      // 手編集 (service を通さない out-of-band 変更) を hash 不一致として検出する。
      const target = join(repo, ".ut-tdd", "memory", "project-alpha-lane.md");
      writeFileSync(target, `${readFileSync(target, "utf8")}\n追記された手編集。\n`, "utf8");
      const drifted = readMemory({ repoRoot: repo, db: fakeIndexDb(fresh) });
      expect(drifted.freshness).toBe("stale");
      expect(drifted.freshness_reason).toContain("content-drift=1");
      expect(renderMemoryHealth(drifted)).toContain("memory index stale");

      // index にしか居ない行 (削除済みファイル) も差分として出す。
      const withGhost = readMemory({
        repoRoot: repo,
        db: fakeIndexDb([...fresh, { memory_id: "memory:project:ghost", content_hash: "x" }]),
      });
      expect(withGhost.freshness).toBe("stale");
      expect(withGhost.freshness_reason).toContain("index-only=1");
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMORY-016: 未投影 (add 直後) を「新鮮」と誤判定しない
  it("reports an entry that the index has never seen as not-indexed", () => {
    const repo = tempRepo();
    try {
      seedCorpus(repo);
      const result = readMemory({ repoRoot: repo, db: fakeIndexDb([]) });
      expect(result.freshness).toBe("stale");
      expect(result.freshness_reason).toContain("not-indexed=4");
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMORY-017: fresh のときだけ health が空 (ノイズを常時出さない)
  it("stays quiet only when the index matches every source file", () => {
    const entries: MemoryEntry[] = [];
    expect(compareIndexToCorpus(entries, []).fresh).toBe(true);
    expect(renderMemoryHealth({ entries: [], findings: [], freshness: "fresh" })).toBe("");
  });

  // U-MEMORY-020: 日本語/句読点で slug が縮退しても identity と source path を分離する。
  it("keeps lossy titles distinct while preserving ASCII-safe ids", () => {
    const japaneseA = "差し戻しと自力修正は排他";
    const japaneseB = "レビュー依頼を取り下げて修正する";
    const idA = memoryIdFor({ kind: "feedback", title: japaneseA });
    const idB = memoryIdFor({ kind: "feedback", title: japaneseB });
    expect(idA).toMatch(/^memory:feedback:memory--[a-f0-9]{12}$/);
    expect(idB).toMatch(/^memory:feedback:memory--[a-f0-9]{12}$/);
    expect(idA).not.toBe(idB);
    expect(memoryIdFor({ kind: "feedback", title: "PR #319 review" })).not.toBe(
      memoryIdFor({ kind: "feedback", title: "PR 319: review" }),
    );
    expect(memoryIdFor({ kind: "project", title: "Service-owned write" })).toBe(
      "memory:project:service-owned-write",
    );

    const repo = tempRepo();
    try {
      const first = writeMemory({
        repoRoot: repo,
        input: {
          kind: "feedback",
          title: japaneseA,
          body: "first",
          now: "2026-08-18T00:00:00.000Z",
        },
      });
      const second = writeMemory({
        repoRoot: repo,
        input: {
          kind: "feedback",
          title: japaneseB,
          body: "second",
          now: "2026-08-18T00:00:01.000Z",
        },
      });
      expect(first.source_path).not.toBe(second.source_path);
      expect(loadMemoryCorpus(repo).entries).toHaveLength(2);

      const legacyPath = join(repo, ".ut-tdd", "memory", "feedback-pr-319-review.md");
      writeFileSync(
        legacyPath,
        [
          "---",
          "memory_id: memory:feedback:pr-319-review",
          "kind: feedback",
          'title: "PR #319 review"',
          "tags: []",
          "updated_at: 2026-08-18T00:00:02.000Z",
          "---",
          "",
          "legacy body",
          "",
        ].join("\n"),
        "utf8",
      );
      const reusedLegacy = writeMemory({
        repoRoot: repo,
        input: {
          kind: "feedback",
          title: "PR #319 review",
          body: "legacy body",
          now: "2026-08-18T00:00:03.000Z",
        },
      });
      expect(reusedLegacy.source_path).toBe(".ut-tdd/memory/feedback-pr-319-review.md");
      expect(
        readdirSync(join(repo, ".ut-tdd", "memory")).some((name) =>
          name.startsWith("feedback-pr-319-review--"),
        ),
      ).toBe(false);
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMORY-021: 同一pathの異なる内容は fail-close、同一内容の再試行だけ冪等。
  it("refuses destructive collisions and accepts an identical retry", () => {
    const repo = tempRepo();
    try {
      const first = writeMemory({
        repoRoot: repo,
        input: {
          kind: "feedback",
          title: "Repeated review request",
          body: "retain the first body",
          tags: ["review"],
          now: "2026-08-18T00:00:00.000Z",
        },
      });
      const target = join(repo, first.source_path);
      const before = readFileSync(target, "utf8");
      expect(() =>
        writeMemory({
          repoRoot: repo,
          input: {
            kind: "feedback",
            title: "Repeated review request",
            body: "a replacement body",
            tags: ["review"],
            now: "2026-08-18T00:00:01.000Z",
          },
        }),
      ).toThrow(/refusing to overwrite/);
      expect(readFileSync(target, "utf8")).toBe(before);

      const retry = writeMemory({
        repoRoot: repo,
        input: {
          kind: "feedback",
          title: "Repeated review request",
          body: "retain the first body",
          tags: ["review"],
          now: "2026-08-18T00:00:02.000Z",
        },
      });
      expect(retry.content_hash).toBe(first.content_hash);
      expect(readFileSync(target, "utf8")).toBe(before);
    } finally {
      removeTestTree(repo);
    }
  });

  // U-MEMORY-018: AC-4 (静的側) — 直アクセスの混入を依存方向で止める
  it("confines memory storage access to the memory module and its projection writer", () => {
    const root = join(
      workspaceRead({
        id: "memory-service-boundary",
        mode: "head_snapshot",
        reason: "PLAN-L7-468 AC-4: memory 直アクセスの混入を HEAD 基準で検査する",
      }),
      "src",
    );
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(root);

    const tableLiteral: string[] = [];
    const dirLiteral: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const rel = file.slice(root.length + 1).replaceAll("\\", "/");
      if (text.includes("memory_entries")) tableLiteral.push(rel);
      if (text.includes('".ut-tdd", "memory"') || text.includes('".ut-tdd/memory')) {
        dirLiteral.push(rel);
      }
    }

    // 依存方向の固定: memory の格納面 (table / 正本ディレクトリ) を触れるモジュールを限定する。
    // allowlist で finding を黙らせるのではなく、面が増えたら赤くする構造境界。
    const ALLOWED_TABLE_ACCESS = new Set([
      "memory/index.ts",
      "memory/service.ts",
      "schema/harness-db-indexes.ts",
      "schema/harness-db-tables-core.ts",
      "state-db/projection-writer.ts",
      "lint/secret-scan.ts",
    ]);
    // 本文を読む面 (service 経由が必須) と、ディレクトリ名を走査対象として持つだけの面を分ける。
    // 後者を無条件に許すと境界が緩むので、本文 parse をしないことを別 assertion で固定する。
    const ALLOWED_DIR_ACCESS = new Set([
      "memory/index.ts",
      "memory/service.ts",
      // These two modules verify the tracked archive/curation evidence only; they do not read
      // canonical memory bodies. The direct-reader assertions below remain the enforcement point.
      "memory/curation-ledger.ts",
      "memory/legacy-archive-manifest.ts",
      "lint/secret-scan.ts",
      "graph/loader.ts",
      "runtime/session-log.ts",
      "state-db/index.ts",
    ]);
    const SCAN_ONLY_DIR_ACCESS = new Set(["lint/memory-sync.ts"]);
    expect(tableLiteral.filter((rel) => !ALLOWED_TABLE_ACCESS.has(rel))).toEqual([]);
    expect(
      dirLiteral.filter((rel) => !ALLOWED_DIR_ACCESS.has(rel) && !SCAN_ONLY_DIR_ACCESS.has(rel)),
    ).toEqual([]);
    // scan-only の面は「git に path を尋ねるだけ」であること。本文を読み始めたら赤くする。
    for (const rel of SCAN_ONLY_DIR_ACCESS) {
      if (!dirLiteral.includes(rel)) continue;
      const text = readFileSync(join(root, rel), "utf8");
      expect(text, `${rel} must not read memory content directly`).not.toContain("readFileSync");
      expect(text, `${rel} must not parse memory content directly`).not.toContain(
        "parseMemoryFile",
      );
    }
    // 読み手 (CLI / digest) が格納面へ戻ることを個別に禁止する。
    expect(tableLiteral).not.toContain("cli.ts");
    expect(tableLiteral).not.toContain("handover/session-start-digest.ts");
    expect(readFileSync(join(root, "cli.ts"), "utf8")).not.toContain("writeMemoryEntry");
    // service が実在し、読み路として登録されていること (境界の空振り防止)。
    expect(tableLiteral).toContain("memory/service.ts");
  });

  // U-MEMORY-019: storage primitive は MemoryService 内部だけ。production の直接利用を fail-close。
  it("rejects production imports, exports, and re-exports of the memory storage primitive", () => {
    const root = join(
      workspaceRead({
        id: "memory-write-service-boundary",
        mode: "head_snapshot",
        reason: "PLAN-L7-189: write は MemoryService 単一路であることを全 production source で検査",
      }),
      "src",
    );
    const violations: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const rel = full.slice(root.length + 1).replaceAll("\\", "/");
        if (rel === "memory/service.ts") continue;
        if (readFileSync(full, "utf8").includes("writeMemoryEntry")) violations.push(rel);
      }
    };
    walk(root);
    expect(violations).toEqual([]);
  });
});

/**
 * issue #353: `memory_id` は title 全長由来なので、そのまま filename にすると Windows の
 * MAX_PATH を超えて checkout 自体が失敗する。filename だけを上限で切り詰め、`memory_id` は
 * 全長を維持するのが凍結した契約 (advisor gpt-5.6-sol)。
 */
describe("memory filename length bound (issue #353)", () => {
  const longTitle = (tail: string): string =>
    `${"forward fsm closing review flag blocking one exact head remediation and delta verdict ".repeat(3)}${tail}`;

  it("keeps names within the bound unchanged", () => {
    const memoryId = memoryIdFor({ kind: "feedback", title: "PR 353 short title" });
    expect(memoryFileNameFor("feedback", memoryId)).toBe(
      `feedback-${memoryId.slice("memory:feedback:".length)}.md`,
    );
  });

  it("keeps a basename of exactly the bound unchanged", () => {
    // `feedback-` (9) + slug + `.md` (3) = 120 になる slug を作る。
    const slug = "a".repeat(MEMORY_FILENAME_MAX - "feedback-".length - ".md".length);
    const name = memoryFileNameFor("feedback", `memory:feedback:${slug}`);
    expect(name.length).toBe(MEMORY_FILENAME_MAX);
    expect(name).toBe(`feedback-${slug}.md`);
  });

  it("truncates one character over the bound and stays within it", () => {
    const slug = "a".repeat(MEMORY_FILENAME_MAX - "feedback-".length - ".md".length + 1);
    const name = memoryFileNameFor("feedback", `memory:feedback:${slug}`);
    expect(name.length).toBeLessThanOrEqual(MEMORY_FILENAME_MAX);
    expect(name).not.toBe(`feedback-${slug}.md`);
    expect(name).toMatch(/-[0-9a-f]{16}\.md$/);
  });

  it("separates two long titles that share a prefix", () => {
    const first = memoryIdFor({ kind: "feedback", title: longTitle("alpha") });
    const second = memoryIdFor({ kind: "feedback", title: longTitle("beta") });
    expect(first).not.toBe(second);
    const firstName = memoryFileNameFor("feedback", first);
    const secondName = memoryFileNameFor("feedback", second);
    expect(firstName).not.toBe(secondName);
    expect(firstName.length).toBeLessThanOrEqual(MEMORY_FILENAME_MAX);
    expect(secondName.length).toBeLessThanOrEqual(MEMORY_FILENAME_MAX);
  });

  it("writes a bounded path while keeping the full memory_id readable", () => {
    const repo = tempRepo();
    try {
      const title = longTitle("gamma");
      const written = writeMemory({
        repoRoot: repo,
        input: { kind: "feedback", title, body: "bounded filename", tags: ["issue-353"] },
      });
      expect(written.memory_id).toBe(memoryIdFor({ kind: "feedback", title }));
      expect(written.source_path.length).toBeLessThanOrEqual(150);
      const files = readdirSync(join(repo, ".ut-tdd", "memory"));
      expect(files).toHaveLength(1);
      expect(files[0].length).toBeLessThanOrEqual(MEMORY_FILENAME_MAX);

      // 切り詰めた filename からでも完全な memory_id を読み戻せる。
      const corpus = loadMemoryCorpus(repo);
      expect(corpus.findings).toEqual([]);
      expect(corpus.entries.map((entry) => entry.memory_id)).toEqual([written.memory_id]);
    } finally {
      removeTestTree(repo);
    }
  });

  it("refuses to overwrite a bounded target that holds a different memory_id", () => {
    const repo = tempRepo();
    try {
      const title = longTitle("delta");
      const memoryId = memoryIdFor({ kind: "feedback", title });
      const fileName = memoryFileNameFor("feedback", memoryId);
      mkdirSync(join(repo, ".ut-tdd", "memory"), { recursive: true });
      writeFileSync(
        join(repo, ".ut-tdd", "memory", fileName),
        [
          "---",
          "memory_id: memory:feedback:some-other-entry",
          "kind: feedback",
          'title: "Some other entry"',
          "tags: []",
          "updated_at: 2026-08-20T00:00:00.000Z",
          "---",
          "",
          "other body",
          "",
        ].join("\n"),
        "utf8",
      );
      expect(() =>
        writeMemory({
          repoRoot: repo,
          input: { kind: "feedback", title, body: "bounded filename", tags: [] },
        }),
      ).toThrow(/refusing to overwrite existing memory/);
    } finally {
      removeTestTree(repo);
    }
  });

  it("holds the shipped corpus within the bound", () => {
    const root = join(
      workspaceRead({
        id: "memory-filename-length-corpus",
        mode: "head_snapshot",
        reason:
          "issue #353: 出荷済み corpus が Windows checkout 可能な長さかを HEAD 基準で検査する",
      }),
      ".ut-tdd",
      "memory",
    );
    const overlong = readdirSync(root).filter(
      (name) => join(".ut-tdd", "memory", name).replaceAll("\\", "/").length > 150,
    );
    expect(overlong).toEqual([]);
  });
});

describe("registrationReceiptFor (PLAN-L6-104 §3.1 decision 7)", () => {
  it("derives content_digest from the exact written bytes, not caller claims", () => {
    const repo = tempRepo();
    try {
      const entry = writeMemory({
        repoRoot: repo,
        input: { kind: "project", title: "receipt digest fixture", body: "receipt body", tags: [] },
      });
      const rawText = readFileSync(join(repo, entry.source_path), "utf8");
      const receipt = registrationReceiptFor({ entry, rawText, operationId: "op-fixture" });
      const expectedDigest = `sha256:${createHash("sha256").update(rawText, "utf8").digest("hex")}`;
      expect(receipt).toEqual({
        operation_id: "op-fixture",
        memory_id: entry.memory_id,
        source_path: entry.source_path,
        content_digest: expectedDigest,
        exit_code: 0,
      });
    } finally {
      removeTestTree(repo);
    }
  });

  it("changes the digest when a single byte of the written content changes", () => {
    const repo = tempRepo();
    try {
      const entry = writeMemory({
        repoRoot: repo,
        input: {
          kind: "project",
          title: "receipt mutation fixture",
          body: "original body",
          tags: [],
        },
      });
      const rawText = readFileSync(join(repo, entry.source_path), "utf8");
      const receiptBefore = registrationReceiptFor({ entry, rawText, operationId: "op-mutate" });
      const mutated = `${rawText}x`;
      const receiptAfter = registrationReceiptFor({
        entry,
        rawText: mutated,
        operationId: "op-mutate",
      });
      expect(receiptAfter.content_digest).not.toBe(receiptBefore.content_digest);
    } finally {
      removeTestTree(repo);
    }
  });
});

describe("ut-tdd memory add --receipt-json (CLI, PLAN-L6-104 §3.1 decision 7)", () => {
  const cliPath = resolve("src/cli.ts");
  const cliFixtures: string[] = [];

  function git(cwd: string, args: readonly string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function createReceiptRepo(projectId = "example/receipt"): string {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-memory-receipt-"));
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "UT-TDD Test"]);
    git(root, ["config", "core.autocrlf", "false"]);
    git(root, ["remote", "add", "origin", `git@github.com:${projectId}.git`]);
    writeFileSync(join(root, "ut-tdd.project.json"), canonicalProjectIdentityBytes(projectId));
    git(root, ["add", "ut-tdd.project.json"]);
    git(root, ["commit", "-q", "-m", "test: seed project identity"]);
    mkdirSync(join(root, ".ut-tdd", "memory"), { recursive: true });
    cliFixtures.push(root);
    return root;
  }

  function runMemoryAdd(cwd: string, args: readonly string[]) {
    return spawnSync(process.execPath, [cliPath, "memory", "add", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: "", UT_TDD_PROJECT_DIR: cwd },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  }

  afterAll(() => {
    while (cliFixtures.length > 0) {
      const fixture = cliFixtures.pop();
      if (fixture) removeTestTree(fixture);
    }
  });

  it("prints a receipt JSON line after the wrote line, bound to the given operation id", () => {
    const repo = createReceiptRepo();
    const result = runMemoryAdd(repo, [
      "--kind",
      "project",
      "--title",
      "T",
      "--body",
      "B",
      "--tags",
      "a,b",
      "--operation-id",
      "op-1",
      "--receipt-json",
    ]);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^memory: wrote /);
    const receipt = JSON.parse(lines[lines.length - 1]);
    expect(receipt.operation_id).toBe("op-1");
    expect(receipt.exit_code).toBe(0);
    expect(receipt.source_path.replaceAll("\\", "/")).toMatch(/^\.ut-tdd\/memory\//);

    const writtenPath = join(repo, receipt.source_path);
    const writtenBytes = readFileSync(writtenPath, "utf8");
    const expectedDigest = `sha256:${createHash("sha256").update(writtenBytes, "utf8").digest("hex")}`;
    expect(receipt.content_digest).toBe(expectedDigest);

    const frontmatterMatch = writtenBytes.match(/memory_id:\s*(\S+)/);
    expect(frontmatterMatch).not.toBeNull();
    expect(receipt.memory_id).toBe(frontmatterMatch?.[1]);
  });

  it("derives operation_id from the written file's content hash prefix when --operation-id is omitted", () => {
    // content_hash embeds updated_at, so the default operation_id is not stable across runs; it is
    // bound to the bytes actually written, which the test re-derives independently from disk.
    const repo = createReceiptRepo("example/receipt-op-default");
    const result = runMemoryAdd(repo, [
      "--kind",
      "project",
      "--title",
      "Default Operation Id",
      "--body",
      "same body text",
      "--receipt-json",
    ]);
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout.trim().split("\n").pop() as string);
    const written = readFileSync(join(repo, receipt.source_path), "utf8");
    const fileHash = createHash("sha256").update(written, "utf8").digest("hex");
    expect(receipt.operation_id).toBe(fileHash.slice(0, 16));
    expect(receipt.content_digest).toBe(`sha256:${fileHash}`);
  });
});
