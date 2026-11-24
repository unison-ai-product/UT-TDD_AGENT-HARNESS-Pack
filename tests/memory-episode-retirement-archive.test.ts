/**
 * Issue #963 archive oracles and expected behavior are frozen in
 * docs/test-design/harness/L7-memory-episode-retirement-test-design.md.
 * This change promotes only 020-027 to formal U-MEMEPI-* IDs in the design and
 * test citations; 001-019 and 028-029 remain candidates. The four `it.fails`
 * cases (020 / 023 / 024 multi-bound_to / 027) reached their target assertions
 * on the minimal scaffold (PR #1180) and merged as Red in PR #1184. Oracles the
 * scaffold already satisfies (021 / 022 / 025 / 026 and the single bound_to
 * half of 024) remain plain `it` regression fences until Green.
 * Every fixture is an isolated temp git repo with an isolated projection DB;
 * neither the shared harness.db nor the real memory corpus is opened.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { memoryFileNameFor, memoryIdFor, parseMemoryFile } from "../src/memory/index.ts";
import { type MemoryArchiveDbPort, retireMemoryEpisodes } from "../src/memory/service.ts";
import {
  createTableSql,
  HARNESS_DB_TABLE_BY_NAME,
  SCHEMA_VERSION,
} from "../src/schema/harness-db.ts";
import { gitTextTrimmedWindowsHidden as git } from "./support/git.ts";
import { ensureTrackedProjectIdentity } from "./support/project-identity-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const nodeRequire = createRequire(resolve("package.json"));
const NOW = "2026-10-20T00:00:00.000Z";
const REPO = "example/repo";
const MANIFEST = join(".ut-tdd", "archive", "memory-episodes", "manifest.jsonl");
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) removeTestTree(root);
});

type RetireInput = Parameters<typeof retireMemoryEpisodes>[0];
type RetirePorts = Omit<NonNullable<Parameters<typeof retireMemoryEpisodes>[1]>, "db">;

/** temp repo 自身の隔離 harness.db に束縛した MemoryArchiveDbPort (実 repo の DB は開かない)。 */
function isolatedDbPort(root: string): MemoryArchiveDbPort {
  const dbPath = join(root, ".ut-tdd", "harness.db");
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly: boolean },
    ) => {
      prepare(sql: string): {
        get(...args: unknown[]): Record<string, unknown> | undefined;
        run(...args: unknown[]): { changes: number | bigint };
      };
      close(): void;
    };
  };
  return {
    inspectEntry({ memoryId, sourcePath, contentHash }) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
        if (version !== SCHEMA_VERSION) return { status: "schema_unready" };
        const table = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'",
          )
          .get();
        if (!table) return { status: "schema_unready" };
        const row = db
          .prepare(
            "SELECT memory_id, source_path, content_hash FROM memory_entries WHERE memory_id = ?",
          )
          .get(memoryId);
        if (!row) return { status: "row_absent" };
        return row.source_path === sourcePath && row.content_hash === contentHash
          ? { status: "match" }
          : { status: "row_mismatch" };
      } finally {
        db.close();
      }
    },
    deleteEntryRow({ memoryId, sourcePath }) {
      const db = new DatabaseSync(dbPath);
      try {
        const result = db
          .prepare("DELETE FROM memory_entries WHERE memory_id = ? AND source_path = ?")
          .run(memoryId, sourcePath);
        return { deleted: Number(result.changes) };
      } finally {
        db.close();
      }
    },
  };
}

function retire(input: RetireInput, ports: RetirePorts = {}) {
  return retireMemoryEpisodes(input, { ...ports, db: isolatedDbPort(input.repoRoot) });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function tempRepo(): string {
  // Windows CI の tmpdir は 8.3 短縮名 (RUNNER~1) を返し git の toplevel (長名) と不一致になるため native で正規化する。
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ut-tdd-memepi-archive-")));
  tempRoots.push(root);
  ensureTrackedProjectIdentity(root, REPO);
  git(root, ["branch", "-M", "main"]);
  mkdirSync(join(root, ".ut-tdd", "memory"), { recursive: true });
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
    ) => {
      exec(sql: string): void;
      close(): void;
    };
  };
  const db = new DatabaseSync(join(root, ".ut-tdd", "harness.db"));
  try {
    const table = HARNESS_DB_TABLE_BY_NAME.get("memory_entries");
    if (!table) throw new Error("memory_entries table definition is required");
    db.exec(createTableSql(table));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } finally {
    db.close();
  }
  return root;
}

function addMergeCommit(root: string, pr: number): string {
  git(root, ["checkout", "-qb", `branch-${pr}`]);
  git(root, ["commit", "--allow-empty", "-qm", `branch work for pull request #${pr}`]);
  git(root, ["checkout", "-q", "main"]);
  git(root, [
    "merge",
    "--no-ff",
    "-m",
    `Merge pull request #${pr} from example/branch-${pr}`,
    `branch-${pr}`,
  ]);
  return git(root, ["rev-parse", "HEAD"]);
}

interface Seeded {
  memoryId: string;
  sourcePath: string;
  absolute: string;
}

/** untracked な declared episode を実 file + 隔離 projection DB 行として置く。 */
function seedEpisode(root: string, title: string, boundTo: string[]): Seeded {
  const memoryId = memoryIdFor({ kind: "project", title });
  const sourcePath = join(".ut-tdd", "memory", memoryFileNameFor("project", memoryId)).replaceAll(
    "\\",
    "/",
  );
  const absolute = join(root, sourcePath);
  const text = [
    "---",
    `memory_id: ${memoryId}`,
    "kind: project",
    `title: ${title}`,
    "updated_at: 2026-10-01T00:00:00.000Z",
    "lifecycle: episode",
    "lifecycle_source: declared",
    "bound_to:",
    ...boundTo.map((url) => `  - ${url}`),
    "---",
    "",
    `${title} body.`,
    "",
  ].join("\n");
  writeFileSync(absolute, text, "utf8");
  const entry = parseMemoryFile(root, sourcePath);
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
    ) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(join(root, ".ut-tdd", "harness.db"));
  try {
    db.prepare(
      "INSERT INTO memory_entries (memory_id, kind, title, body, tags, source_path, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      entry.memory_id,
      entry.kind,
      entry.title,
      entry.body,
      entry.tags.join(","),
      entry.source_path,
      entry.updated_at,
      entry.content_hash,
    );
  } finally {
    db.close();
  }
  return { memoryId, sourcePath, absolute };
}

function dbHasRow(root: string, memoryId: string): boolean {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options: { readOnly: true },
    ) => { prepare(sql: string): { get(...p: unknown[]): unknown }; close(): void };
  };
  const db = new DatabaseSync(join(root, ".ut-tdd", "harness.db"), { readOnly: true });
  try {
    return (
      db.prepare("SELECT 1 FROM memory_entries WHERE memory_id = ?").get(memoryId) !== undefined
    );
  } finally {
    db.close();
  }
}

function manifestLines(root: string): string[] {
  const path = join(root, MANIFEST);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

const EVENT_KEYS = [
  "bound_to",
  "bytes",
  "destination_path",
  "memory_id",
  "recorded_at",
  "schema",
  "selection_basis",
  "sha256",
  "source_path",
  "state",
];

function memoryRowsJson(root: string, memoryId: string): string {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options: { readOnly: true },
    ) => { prepare(sql: string): { all(...p: unknown[]): unknown[] }; close(): void };
  };
  const db = new DatabaseSync(join(root, ".ut-tdd", "harness.db"), { readOnly: true });
  try {
    return JSON.stringify(
      db.prepare("SELECT * FROM memory_entries WHERE memory_id = ?").all(memoryId),
    );
  } finally {
    db.close();
  }
}

const closedResolver = () => ({ state: "closed" as const });

describe("memory episode archive Red oracles (#963)", () => {
  it("U-MEMEPI-020 accepts a valid done row only and conflicts on every invalid state", () => {
    const root = tempRepo();
    const a = seedEpisode(root, "Episode A", [`https://github.com/${REPO}/pull/11`]);
    const first = retire(
      { repoRoot: root, nowISO: NOW, dryRun: false },
      { resolveGitHubStatus: closedResolver },
    );
    expect(first).toMatchObject({ ok: true });
    const lines = manifestLines(root);
    expect(lines).toHaveLength(2);
    const done = JSON.parse(lines[1] ?? "{}") as { destination_path: string; state: string };
    expect(done.state).toBe("done");
    const destination = join(root, done.destination_path);
    const goodBytes = readFileSync(destination);
    const manifestBefore = readFileSync(join(root, MANIFEST), "utf8");

    // 正当形: source absent + destination present + SHA 一致 -> 処理済みとして受理、重複 done なし。
    const valid = retire({ repoRoot: root, nowISO: NOW, dryRun: false });
    expect(valid).toMatchObject({ ok: true });
    expect(readFileSync(join(root, MANIFEST), "utf8")).toBe(manifestBefore);
    expect(readFileSync(destination).equals(goodBytes)).toBe(true);
    expect(existsSync(a.absolute)).toBe(false);

    // 不正形: 全 entry preflight で conflict、他 entry (B) は新規処理しない。
    const b = seedEpisode(root, "Episode B", [`https://github.com/${REPO}/pull/12`]);
    const bBytes = readFileSync(b.absolute);
    const forms: Array<[string, () => void, () => void]> = [
      [
        "source present / destination absent",
        () => renameSync(destination, a.absolute),
        () => renameSync(a.absolute, destination),
      ],
      ["both present", () => copyFileSync(destination, a.absolute), () => rmSync(a.absolute)],
      [
        "both absent",
        () => renameSync(destination, `${destination}.hold`),
        () => renameSync(`${destination}.hold`, destination),
      ],
      [
        "hash mismatch",
        () => writeFileSync(destination, Buffer.concat([goodBytes, Buffer.from("x")])),
        () => writeFileSync(destination, goodBytes),
      ],
    ];
    for (const [label, mutate, restore] of forms) {
      mutate();
      const result = retire(
        { repoRoot: root, nowISO: NOW, dryRun: false },
        { resolveGitHubStatus: closedResolver },
      );
      expect(result, label).toEqual({ ok: false, reason: "memory_archive_recovery_conflict" });
      expect(readFileSync(join(root, MANIFEST), "utf8"), label).toBe(manifestBefore);
      expect(readFileSync(b.absolute).equals(bBytes), label).toBe(true);
      expect(dbHasRow(root, b.memoryId), label).toBe(true);
      restore();
    }
  });

  it("U-MEMEPI-023 records the real first-parent merge SHA with identical intent/done payload and no resolver call", () => {
    const root = tempRepo();
    const sha = addMergeCommit(root, 10);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const url = `https://github.com/${REPO}/pull/10`;
    const entry = seedEpisode(root, "Episode merged", [url]);
    let resolverCalls = 0;
    const result = retire(
      { repoRoot: root, nowISO: NOW, dryRun: false },
      {
        resolveGitHubStatus: () => {
          resolverCalls += 1;
          return { state: "unknown" };
        },
      },
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.moved.map((m) => m.memory_id)).toEqual([entry.memoryId]);
    expect(resolverCalls).toBe(0);
    const [intent, done] = manifestLines(root).map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(Object.keys(intent ?? {}).sort()).toEqual(
      [
        "bound_to",
        "bytes",
        "destination_path",
        "memory_id",
        "recorded_at",
        "schema",
        "selection_basis",
        "sha256",
        "source_path",
        "state",
      ].sort(),
    );
    expect(intent?.selection_basis).toEqual({
      kind: "memory-episode-closure/v1",
      lifecycle_source: "declared",
      closed_evidence: [{ url, via: "git_first_parent_merge", commit_sha: sha }],
    });
    expect(intent?.recorded_at).toBe(NOW);
    expect({ ...done, state: "intent" }).toEqual(intent);
    expect(done?.state).toBe("done");
  });

  it("U-MEMEPI-024 records github_closed evidence for every bound_to URL in URL order with exact event keys", () => {
    const pull = `https://github.com/${REPO}/pull/11`;
    const issue = `https://github.com/${REPO}/issues/20`;
    // PR + issue の複数 bound_to: 宣言順に依らず URL 昇順で全 evidence を記録する。
    const multi = tempRepo();
    const entry = seedEpisode(multi, "Episode multi", [pull, issue]);
    const result = retire(
      { repoRoot: multi, nowISO: NOW, dryRun: false },
      { resolveGitHubStatus: closedResolver },
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.moved.map((m) => m.memory_id)).toEqual([entry.memoryId]);
    const [intent, done] = manifestLines(multi).map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(Object.keys(intent ?? {}).sort()).toEqual(EVENT_KEYS);
    expect(Object.keys(done ?? {}).sort()).toEqual(EVENT_KEYS);
    expect(intent?.state).toBe("intent");
    expect(done?.state).toBe("done");
    expect(intent?.schema).toBe("ut-tdd.memory-episode-archive/v1");
    expect(done?.schema).toBe("ut-tdd.memory-episode-archive/v1");
    expect(intent?.bound_to).toEqual([issue, pull]);
    expect(intent?.selection_basis).toEqual({
      kind: "memory-episode-closure/v1",
      lifecycle_source: "declared",
      closed_evidence: [
        { url: issue, via: "github_closed", observed_state: "closed" },
        { url: pull, via: "github_closed", observed_state: "closed" },
      ],
    });
    expect(Object.keys((intent?.selection_basis as object) ?? {}).sort()).toEqual([
      "closed_evidence",
      "kind",
      "lifecycle_source",
    ]);
    expect(intent?.recorded_at).toBe(NOW);
    expect({ ...done, state: "intent" }).toEqual(intent);
  });

  it("U-MEMEPI-027 keeps a valid foreign state-channel row, file and DB row out of #963 selection and recovery", () => {
    const root = tempRepo();
    const entry = seedEpisode(root, "Episode own", [`https://github.com/${REPO}/pull/11`]);
    const foreignId = "memory:project:foreign";
    const foreignSource = ".ut-tdd/memory/project-foreign.md";
    const foreignDestination = join(
      ".ut-tdd",
      "archive",
      "memory-episodes",
      "2026-09",
      "project-foreign.md",
    ).replaceAll("\\", "/");
    mkdirSync(dirname(join(root, foreignDestination)), { recursive: true });
    const foreignBytes = "foreign archived bytes\n";
    writeFileSync(join(root, foreignDestination), foreignBytes, "utf8");
    const foreignSha = sha256(foreignBytes);
    // foreign owner (#1062) が rename 後・DB delete 前で止まっている有効な intent と DB row。
    const foreignRow = JSON.stringify({
      schema: "ut-tdd.state-channel-memory-archive/v1",
      state: "intent",
      memory_id: foreignId,
      source_path: foreignSource,
      destination_path: foreignDestination,
      sha256: foreignSha,
      bytes: Buffer.byteLength(foreignBytes),
      bound_to: [],
      selection_basis: {
        kind: "state-channel-target-snapshot/v1",
        snapshot_sha256: sha256("snapshot"),
        memory_id: foreignId,
        content_sha256: foreignSha,
      },
      recorded_at: "2026-09-30T00:00:00.000Z",
    });
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (
        path: string,
      ) => { prepare(sql: string): { run(...p: unknown[]): unknown }; close(): void };
    };
    const seedDb = new DatabaseSync(join(root, ".ut-tdd", "harness.db"));
    try {
      seedDb
        .prepare(
          "INSERT INTO memory_entries (memory_id, kind, title, body, tags, source_path, updated_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          foreignId,
          "project",
          "Foreign",
          "foreign body",
          "",
          foreignSource,
          "2026-09-01T00:00:00.000Z",
          foreignSha,
        );
    } finally {
      seedDb.close();
    }
    mkdirSync(dirname(join(root, MANIFEST)), { recursive: true });
    writeFileSync(join(root, MANIFEST), `${foreignRow}\n`, "utf8");
    const foreignDbBefore = memoryRowsJson(root, foreignId);
    expect(foreignDbBefore).not.toBe("[]");

    const result = retire(
      { repoRoot: root, nowISO: NOW, dryRun: false },
      { resolveGitHubStatus: closedResolver },
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.moved.map((m) => m.memory_id)).toEqual([entry.memoryId]);
    const lines = manifestLines(root);
    expect(lines[0]).toBe(foreignRow);
    expect(lines).toHaveLength(3);
    expect(readFileSync(join(root, foreignDestination), "utf8")).toBe(foreignBytes);
    expect(memoryRowsJson(root, foreignId)).toBe(foreignDbBefore);
    expect(dbHasRow(root, entry.memoryId)).toBe(false);
    expect(readdirSync(join(root, ".ut-tdd", "memory"))).toEqual([]);
  });
});

/**
 * 以下は足場 (#1180) が既に満たす oracle の回帰 fence。Green が
 * 「既存 manifest なら無条件 conflict」を closed-schema 検証へ置き換えたとき、
 * 黙示 skip / 未知 row の無視 / I/O 前停止の崩れを捕まえる。
 */
describe("memory episode archive regression fences satisfied by the scaffold (#963)", () => {
  it("U-MEMEPI-021 conflicts when the destination already exists and keeps every byte", () => {
    const root = tempRepo();
    const e = seedEpisode(root, "Episode D", [`https://github.com/${REPO}/pull/11`]);
    const dest = join(
      root,
      ".ut-tdd",
      "archive",
      "memory-episodes",
      "2026-10",
      e.sourcePath.split("/").pop() as string,
    );
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, "pre-existing destination", "utf8");
    const sourceBefore = readFileSync(e.absolute);
    const dbBefore = memoryRowsJson(root, e.memoryId);
    const result = retire(
      { repoRoot: root, nowISO: NOW, dryRun: false },
      { resolveGitHubStatus: closedResolver },
    );
    expect(result).toEqual({ ok: false, reason: "memory_archive_recovery_conflict" });
    expect(readFileSync(dest, "utf8")).toBe("pre-existing destination");
    expect(readFileSync(e.absolute).equals(sourceBefore)).toBe(true);
    expect(memoryRowsJson(root, e.memoryId)).toBe(dbBefore);
    expect(existsSync(join(root, MANIFEST))).toBe(false);
  });

  it("U-MEMEPI-021 conflicts, not silently skips, when a new source reuses an archived memory_id", () => {
    const root = tempRepo();
    const url = `https://github.com/${REPO}/pull/11`;
    const first = seedEpisode(root, "Episode E", [url]);
    expect(
      retire(
        { repoRoot: root, nowISO: NOW, dryRun: false },
        { resolveGitHubStatus: closedResolver },
      ),
    ).toMatchObject({ ok: true });
    const archivedDestination = join(
      root,
      (JSON.parse(manifestLines(root)[1] ?? "{}") as { destination_path: string }).destination_path,
    );
    const archivedBytes = readFileSync(archivedDestination);
    const second = seedEpisode(root, "Episode E", [url]);
    expect(second.memoryId).toBe(first.memoryId);
    const sourceBefore = readFileSync(second.absolute);
    const dbBefore = memoryRowsJson(root, second.memoryId);
    const manifestBefore = readFileSync(join(root, MANIFEST), "utf8");
    const result = retire(
      { repoRoot: root, nowISO: NOW, dryRun: false },
      { resolveGitHubStatus: closedResolver },
    );
    expect(result).toEqual({ ok: false, reason: "memory_archive_recovery_conflict" });
    expect(readFileSync(second.absolute).equals(sourceBefore)).toBe(true);
    expect(readFileSync(archivedDestination).equals(archivedBytes)).toBe(true);
    expect(memoryRowsJson(root, second.memoryId)).toBe(dbBefore);
    expect(readFileSync(join(root, MANIFEST), "utf8")).toBe(manifestBefore);
  });

  it("U-MEMEPI-022 throws TypeError synchronously for an invalid nowISO before any I/O", () => {
    for (const dryRun of [true, false]) {
      for (const nowISO of ["", "not-a-date", "2026-13-40", "2026-10-20T00:00:00+09:00"]) {
        const root = tempRepo();
        const e = seedEpisode(root, "Episode H", [`https://github.com/${REPO}/pull/11`]);
        const sourceBefore = readFileSync(e.absolute);
        const dbFileBefore = readFileSync(join(root, ".ut-tdd", "harness.db"));
        const memoryDirBefore = readdirSync(join(root, ".ut-tdd", "memory"));
        const label = `${nowISO} dryRun=${dryRun}`;
        expect(
          () => retire({ repoRoot: root, nowISO, dryRun }, { resolveGitHubStatus: closedResolver }),
          label,
        ).toThrow(TypeError);
        expect(existsSync(join(root, ".ut-tdd", "archive")), label).toBe(false);
        expect(readFileSync(e.absolute).equals(sourceBefore), label).toBe(true);
        expect(readdirSync(join(root, ".ut-tdd", "memory")), label).toEqual(memoryDirBefore);
        expect(readFileSync(join(root, ".ut-tdd", "harness.db")).equals(dbFileBefore), label).toBe(
          true,
        );
      }
    }
  });

  for (const [label, row] of [
    ["unknown schema row", '{"schema":"example/unknown/v9","state":"done"}'],
    ["malformed known #963 row", '{"schema":"ut-tdd.memory-episode-archive/v1","state":"done"}'],
    [
      "malformed known #1062 row",
      '{"schema":"ut-tdd.state-channel-memory-archive/v1","state":"done"}',
    ],
  ] as const) {
    it(`U-MEMEPI-025 stops the whole run on a ${label} and leaves everything unchanged`, () => {
      const root = tempRepo();
      const url = `https://github.com/${REPO}/pull/11`;
      const a = seedEpisode(root, "Episode F1", [url]);
      const b = seedEpisode(root, "Episode F2", [url]);
      mkdirSync(dirname(join(root, MANIFEST)), { recursive: true });
      writeFileSync(join(root, MANIFEST), `${row}\n`, "utf8");
      const before = [a, b].map((s) => ({
        s,
        bytes: readFileSync(s.absolute),
        db: memoryRowsJson(root, s.memoryId),
      }));
      const result = retire(
        { repoRoot: root, nowISO: NOW, dryRun: false },
        { resolveGitHubStatus: closedResolver },
      );
      expect(result).toEqual({ ok: false, reason: "memory_archive_recovery_conflict" });
      expect(readFileSync(join(root, MANIFEST), "utf8")).toBe(`${row}\n`);
      for (const { s, bytes, db } of before) {
        expect(readFileSync(s.absolute).equals(bytes)).toBe(true);
        expect(memoryRowsJson(root, s.memoryId)).toBe(db);
      }
      expect(existsSync(join(root, ".ut-tdd", "archive", "memory-episodes", "2026-10"))).toBe(
        false,
      );
    });
  }

  for (const [label, resolver] of [
    [
      "throws",
      () => {
        throw new Error("network unreachable");
      },
    ],
    ["returns an unknown state value", () => ({ state: "weird" })],
    ["returns null", () => null],
    ["returns a non-object", () => "closed"],
  ] as const) {
    it(`U-MEMEPI-026 maps a resolver that ${label} to unknown without any write`, () => {
      const root = tempRepo();
      const e = seedEpisode(root, "Episode G", [`https://github.com/${REPO}/pull/11`]);
      const sourceBefore = readFileSync(e.absolute);
      const dbBefore = memoryRowsJson(root, e.memoryId);
      const result = retire(
        { repoRoot: root, nowISO: NOW, dryRun: false },
        { resolveGitHubStatus: resolver as never },
      );
      expect(result).toMatchObject({ ok: true, total: 1 });
      expect(result.ok && result.counts.episode_unknown_declared).toBe(1);
      expect(result.ok && result.counts.episode_retirable_declared).toBe(0);
      expect(result.ok && result.moved).toEqual([]);
      expect(result.ok && result.retirable).toEqual([]);
      expect(readFileSync(e.absolute).equals(sourceBefore)).toBe(true);
      expect(memoryRowsJson(root, e.memoryId)).toBe(dbBefore);
      expect(existsSync(join(root, MANIFEST))).toBe(false);
    });
  }

  it("U-MEMEPI-024 (single bound_to) records the exact intent/done event keys and github_closed evidence", () => {
    const pull = `https://github.com/${REPO}/pull/11`;
    const single = tempRepo();
    const e = seedEpisode(single, "Episode single", [pull]);
    expect(
      retire(
        { repoRoot: single, nowISO: NOW, dryRun: false },
        { resolveGitHubStatus: closedResolver },
      ),
    ).toMatchObject({ ok: true });
    const [intent, done] = manifestLines(single).map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(manifestLines(single)).toHaveLength(2);
    expect(Object.keys(intent ?? {}).sort()).toEqual(EVENT_KEYS);
    expect(Object.keys(done ?? {}).sort()).toEqual(EVENT_KEYS);
    expect(intent?.state).toBe("intent");
    expect(done?.state).toBe("done");
    expect(intent?.schema).toBe("ut-tdd.memory-episode-archive/v1");
    expect(intent?.memory_id).toBe(e.memoryId);
    expect(intent?.bound_to).toEqual([pull]);
    expect(intent?.selection_basis).toEqual({
      kind: "memory-episode-closure/v1",
      lifecycle_source: "declared",
      closed_evidence: [{ url: pull, via: "github_closed", observed_state: "closed" }],
    });
    expect(intent?.recorded_at).toBe(NOW);
    expect({ ...done, state: "intent" }).toEqual(intent);
  });
});
