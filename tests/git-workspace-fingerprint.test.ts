import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ChunkedFileIo,
  hashFileChunked,
  hashFileChunkedWithDiagnostics,
} from "./support/chunked-hash.ts";
import {
  assertGitWorkspaceUnchanged,
  captureGitWorkspaceFingerprint,
  captureWorkspaceInventory,
  type GitWorkspaceFingerprint,
} from "./support/git-workspace-fingerprint.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const fingerprint: GitWorkspaceFingerprint = {
  head: "head",
  statusDigest: "status",
  worktreeDigest: "worktree",
  indexDigest: "index",
  untrackedDigest: "untracked",
  inventoryDigest: "inventory",
  inventoryEntries: [],
};

describe("git workspace fence", () => {
  it("U-TESTHYGIENE-016: inventories ignored files and empty directories", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-fence-"));
    try {
      const before = captureWorkspaceInventory(root).digest;
      mkdirSync(join(root, ".ut-tdd", "gate_runs"), { recursive: true });
      expect(captureWorkspaceInventory(root).digest).not.toBe(before);
      writeFileSync(join(root, ".ut-tdd", "gate_runs", "leak.json"), "{}\n");
      expect(captureWorkspaceInventory(root).digest).not.toBe(before);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-TESTHYGIENE-056: ignores volatile harness DB family content changes", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-fence-volatile-"));
    try {
      const runtimeDirectory = join(root, ".ut-tdd");
      const volatileFiles = [
        "harness.db",
        "harness.db-journal",
        "harness.db-wal",
        "harness.db-shm",
      ];
      mkdirSync(runtimeDirectory, { recursive: true });
      for (const file of volatileFiles) writeFileSync(join(runtimeDirectory, file), "before\n");

      const before = captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest;
      for (const file of volatileFiles) {
        writeFileSync(join(runtimeDirectory, file), `after-${file}\n`);
        expect(captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest).toBe(before);
      }
    } finally {
      removeTestTree(root);
    }
  });

  /**
   * 「読まない」は observable な帰結 (entry が content 由来の digest を持たないこと) で主張する。
   * `openSync(path, "r+")` で lock を作る形は空振りする — libuv は
   * `FILE_SHARE_READ|WRITE|DELETE` を立てるので Windows でも読み取りを阻害せず、
   * 除外を外した実装でも `not.toThrow()` が成立してしまう (blind review F-2)。
   */
  it("U-TESTHYGIENE-057: emits a content-free entry for the volatile harness DB family", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-fence-volatile-entry-"));
    try {
      const runtimeDirectory = join(root, ".ut-tdd");
      mkdirSync(runtimeDirectory, { recursive: true });
      for (const file of ["harness.db", "harness.db-journal", "harness.db-wal", "harness.db-shm"]) {
        writeFileSync(join(runtimeDirectory, file), "content\n");
      }
      const { entries } = captureWorkspaceInventory(root, { volatileRuntimeIndex: true });
      const volatileEntries = entries.filter((e) => e.startsWith("f:.ut-tdd/harness.db"));
      expect(volatileEntries).toHaveLength(4);
      // content hash (sha256 hex 64 桁) を含まない = 読んでいない。
      for (const entry of volatileEntries) expect(entry).not.toMatch(/:[0-9a-f]{64}$/);
      // 既定 (option 無し) では同じ 4 entry が content hash を持つ (検知力の非破壊)。
      const defaultEntries = captureWorkspaceInventory(root).entries.filter((e) =>
        e.startsWith("f:.ut-tdd/harness.db"),
      );
      expect(defaultEntries).toHaveLength(4);
      for (const entry of defaultEntries) expect(entry).toMatch(/:[0-9a-f]{64}$/);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-TESTHYGIENE-058: keeps default inventory sensitive to harness DB content", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-fence-default-db-"));
    try {
      const dbPath = join(root, ".ut-tdd", "harness.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      writeFileSync(dbPath, "before\n");
      const before = captureWorkspaceInventory(root).digest;
      writeFileSync(dbPath, "after\n");
      expect(captureWorkspaceInventory(root).digest).not.toBe(before);
    } finally {
      removeTestTree(root);
    }
  });

  it("U-TESTHYGIENE-059: retains ignored files and empty directories in volatile inventory", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-fence-volatile-structure-"));
    try {
      const before = captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest;
      const gateRuns = join(root, ".ut-tdd", "gate_runs");
      mkdirSync(gateRuns, { recursive: true });
      const withEmptyDirectory = captureWorkspaceInventory(root, {
        volatileRuntimeIndex: true,
      }).digest;
      expect(withEmptyDirectory).not.toBe(before);
      writeFileSync(join(gateRuns, "leak.json"), "{}\n");
      expect(captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest).not.toBe(
        withEmptyDirectory,
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("U-TESTHYGIENE-060: retains volatile harness DB creation and deletion", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-fence-volatile-presence-"));
    try {
      const dbPath = join(root, ".ut-tdd", "harness.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      const withoutDb = captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest;
      writeFileSync(dbPath, "present\n");
      const withDb = captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest;
      expect(withDb).not.toBe(withoutDb);
      rmSync(dbPath);
      expect(captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest).not.toBe(
        withDb,
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("U-TESTHYGIENE-061: retains volatile harness DB type changes", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-fence-volatile-type-"));
    try {
      const dbPath = join(root, ".ut-tdd", "harness.db");
      const targetPath = join(root, ".ut-tdd", "symlink-target.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      writeFileSync(targetPath, "target\n");
      writeFileSync(dbPath, "regular\n");
      const regularFile = captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest;
      rmSync(dbPath);
      try {
        symlinkSync(targetPath, dbPath, "file");
      } catch {
        mkdirSync(dbPath);
      }
      expect(captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest).not.toBe(
        regularFile,
      );
    } finally {
      removeTestTree(root);
    }
  });

  it.each([
    ".ut-tdd/harness.db.bak",
    ".ut-tdd/sub/harness.db",
    "harness.db",
    // 除外は case-sensitive な exact 一致。大文字表記は除外に当たらず検知側へ倒れる。
    ".ut-tdd/HARNESS.DB",
  ])("U-TESTHYGIENE-062: remains sensitive to content changes outside the exact volatile path (%s)", (relativePath) => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-fence-volatile-exact-"));
    try {
      const filePath = join(root, ...relativePath.split("/"));
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "before\n");
      const before = captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest;
      writeFileSync(filePath, "after\n");
      expect(captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest).not.toBe(
        before,
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("U-TESTHYGIENE-063: remains sensitive to ordinary .ut-tdd file content changes", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-fence-volatile-ordinary-"));
    try {
      const logPath = join(root, ".ut-tdd", "logs", "x.log");
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, "before\n");
      const before = captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest;
      writeFileSync(logPath, "after\n");
      expect(captureWorkspaceInventory(root, { volatileRuntimeIndex: true }).digest).not.toBe(
        before,
      );
    } finally {
      removeTestTree(root);
    }
  });

  it("U-TESTHYGIENE-010: accepts an unchanged dirty baseline", () => {
    expect(() => assertGitWorkspaceUnchanged(fingerprint, { ...fingerprint })).not.toThrow();
  });

  it("U-TESTHYGIENE-020: inventories a non-Git distribution tree without invoking Git", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-pack-fence-"));
    try {
      expect(captureGitWorkspaceFingerprint(root).head).toBe("non-git");
    } finally {
      removeTestTree(root);
    }
  });

  it.each([
    "head",
    "statusDigest",
    "worktreeDigest",
    "indexDigest",
    "untrackedDigest",
    "inventoryDigest",
  ] as const)("U-TESTHYGIENE-011: rejects a changed %s component", (key) => {
    expect(() =>
      assertGitWorkspaceUnchanged(fingerprint, { ...fingerprint, [key]: "mutated" }),
    ).toThrow("workspace fence violation");
  });

  describe("chunked file hash (PLAN-L7-457, issue #118)", () => {
    const CHUNK = 64 * 1024; // 実 8MiB は使わず小さいチャンク長を注入して境界を検証する

    it.each([
      ["empty", 0],
      ["tiny", 10],
      ["chunk-minus-1", CHUNK - 1],
      ["chunk-exact", CHUNK],
      ["chunk-plus-1", CHUNK + 1],
      ["multi-chunk", CHUNK * 2 + 37],
    ] as const)("U-FSTREAM-1: chunked hash matches whole-buffer sha256 for a %s file (%i bytes)", (_label, size) => {
      const root = mkdtempSync(join(tmpdir(), "ut-tdd-fstream-"));
      try {
        const path = join(root, "content.bin");
        const buffer = Buffer.alloc(size);
        for (let i = 0; i < size; i += 1) buffer[i] = i % 251;
        writeFileSync(path, buffer);
        const expected = createHash("sha256").update(readFileSync(path)).digest("hex");
        expect(hashFileChunked(path, CHUNK)).toBe(expected);
      } finally {
        removeTestTree(root);
      }
    });

    it("U-FSTREAM-2: the read loop keeps consuming after a partial read down to EOF", () => {
      const root = mkdtempSync(join(tmpdir(), "ut-tdd-fstream-partial-"));
      try {
        const path = join(root, "content.bin");
        const size = CHUNK * 2 + 777;
        const buffer = Buffer.alloc(size);
        for (let i = 0; i < size; i += 1) buffer[i] = (i * 7) % 251;
        writeFileSync(path, buffer);
        const expected = createHash("sha256").update(readFileSync(path)).digest("hex");

        // 1 回の readSync が要求長 (chunkSize) より小さい値しか返さない状況を注入する
        // (実 OS の部分 read 相当)。ループが EOF まで正しく続行しないと digest がずれる。
        let readCalls = 0;
        const subChunkSize = 1000;
        const partialReadIo: ChunkedFileIo = {
          openSync,
          closeSync,
          readSync: (fd, target, offset, length, position) => {
            readCalls += 1;
            return readSync(fd, target, offset, Math.min(length, subChunkSize), position);
          },
        };

        expect(hashFileChunked(path, CHUNK, partialReadIo)).toBe(expected);
        expect(readCalls).toBeGreaterThan(Math.ceil(size / subChunkSize));
      } finally {
        removeTestTree(root);
      }
    });

    it("U-FSTREAM-3: read failures are wrapped with the relative path and size", () => {
      const root = mkdtempSync(join(tmpdir(), "ut-tdd-fstream-fail-"));
      try {
        const missing = join(root, "does-not-exist.bin");
        expect(() =>
          hashFileChunkedWithDiagnostics("workspace fence", missing, "does-not-exist.bin", 1234),
        ).toThrow(/workspace fence failed reading does-not-exist\.bin \(1234 bytes\): /);
      } finally {
        removeTestTree(root);
      }
    });
  });
});
