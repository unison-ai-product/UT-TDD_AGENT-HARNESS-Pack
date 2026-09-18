import type { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitFeedbackEvents } from "../src/feedback/engine.ts";
import {
  D2D_CUTOFF_BASELINE,
  formatPostMergeBackstop,
  MAX_MERGED_PR_PAGES,
  MERGED_PR_PAGE_SIZE,
  POST_MERGE_COMMAND_TIMEOUT_MS,
  POST_MERGE_GH_MAX_BUFFER_BYTES,
  type PostMergeBackstopResult,
  scanPostMergeBackstop,
} from "../src/feedback/post-merge-backstop.ts";
import {
  renderSessionStartDigest,
  selectSessionStartDigest,
} from "../src/handover/session-start-digest.ts";
import { type HarnessDb, openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";

const AFTER_CUTOFF = "2026-08-14T02:00:00.000Z";
const NOW = "2026-08-14T03:00:00.000Z";
const roots: string[] = [];
const databases: HarnessDb[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ut-tdd-d2d-"));
  roots.push(value);
  return value;
}

function sha(value: number, offset = 0): string {
  return (value + offset).toString(16).padStart(40, "0");
}

function merged(pr: number, mergedAt = AFTER_CUTOFF): Record<string, unknown> {
  return {
    number: pr,
    merged_at: mergedAt,
    merge_commit_sha: sha(pr, 10000),
    head: { sha: sha(pr) },
  };
}

function receipt(rootPath: string, pr: number): void {
  const directory = join(rootPath, ".ut-tdd", "logs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "review-merge-gate.jsonl"),
    `${JSON.stringify({
      receiptKind: "merge_result",
      pr,
      headSha: sha(pr),
      verdict: "PASS",
      decision: "merge",
      reason: "merge_ready",
      timestamp: NOW,
      authorizedEntry: {
        memoryId: `memory-${pr}`,
        reviewRevision: `revision-${pr}`,
        reviewerFamily: "codex",
      },
    })}\n`,
    "utf8",
  );
}

function request(rootPath: string, pr: number): void {
  const directory = join(rootPath, ".ut-tdd", "review", "requests");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "request.json"),
    JSON.stringify({
      memoryId: `memory-${pr}`,
      pr,
      exactHead: sha(pr),
      reviewRevision: `revision-${pr}`,
      authorFamily: "claude",
      requestedAt: "2026-08-14T00:00:00.000Z",
    }),
    "utf8",
  );
}

function scan(
  rootPath: string,
  pages: unknown[],
  options: { now?: string; fetch?: (page: number, perPage: number) => unknown } = {},
): PostMergeBackstopResult {
  return scanPostMergeBackstop({
    repoRoot: rootPath,
    now: options.now ?? NOW,
    fetchMergedPrPage:
      options.fetch ??
      ((page, perPage) => {
        expect(perPage).toBe(MERGED_PR_PAGE_SIZE);
        return pages[page - 1] ?? [];
      }),
  });
}

function memoryDb(): HarnessDb {
  const db = openHarnessDb(":memory:");
  migrate(db);
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("D2-D post-merge bypass backstop", () => {
  it("U-RVMG-015: wrapper merge_result decision=merge receipt は誤検知しない", () => {
    const repoRoot = root();
    receipt(repoRoot, 501);

    const result = scan(repoRoot, [[merged(501)]]);

    expect(result).toMatchObject({ ok: true, detections: [] });
  });

  it("U-RVMG-015: 必須 custody field が欠けた forged receipt は bypass を隠さない", () => {
    const repoRoot = root();
    const directory = join(repoRoot, ".ut-tdd", "logs");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "review-merge-gate.jsonl"),
      `${JSON.stringify({
        receiptKind: "merge_result",
        pr: 501,
        headSha: sha(501),
        decision: "merge",
      })}\n`,
      "utf8",
    );

    const result = scan(repoRoot, [[merged(501)]]);

    expect(result.detections).toContainEqual(
      expect.objectContaining({ reason: "bypass_merge", pr: 501 }),
    );
  });

  it("U-RVMG-016: receipt 無し merge は bypass_merge として検知される", () => {
    const repoRoot = root();

    const result = scan(repoRoot, [[merged(502)]]);

    expect(result.detections).toContainEqual(
      expect.objectContaining({ reason: "bypass_merge", pr: 502 }),
    );
  });

  it("U-RVMG-017: cutoff baseline より前の merge は対象外で tracked 定数を使う", () => {
    const repoRoot = root();

    const result = scan(repoRoot, [[merged(503, "2026-08-14T01:20:04.999Z")]]);

    expect(D2D_CUTOFF_BASELINE).toBe("2026-08-14T01:20:05.000Z");
    expect(result.detections).toEqual([]);
  });

  it("U-RVMG-018: D1 analyzer の merged_without_verdict を PR exact HEAD で検知する", () => {
    const repoRoot = root();
    receipt(repoRoot, 504);
    request(repoRoot, 504);

    const result = scan(repoRoot, [[merged(504)]]);

    expect(result.detections).toContainEqual(
      expect.objectContaining({ reason: "merged_without_verdict", pr: 504 }),
    );
  });

  it("U-RVMG-019: gh api 不能は digest と feedback event に検知不能を明示する", () => {
    const unavailable: PostMergeBackstopResult = {
      ok: false,
      detections: [],
      pagesScanned: 0,
      unavailableReason: "gh_api_unavailable",
    };
    const db = memoryDb();
    const digest = selectSessionStartDigest(db, [], { postMergeBackstop: unavailable });
    const events = emitFeedbackEvents(db, { postMergeBackstop: unavailable });

    expect(renderSessionStartDigest(digest)).toContain("detection unavailable");
    expect(events).toContainEqual(
      expect.objectContaining({
        signal_type: "post_merge_backstop:detection_unavailable",
        status: "open",
      }),
    );
  });

  it("U-RVMG-019: default gh adapter は timeout を固定し page 1 失敗を検知不能にする", () => {
    const repoRoot = root();
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }> = [];
    const run = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      if (command === "git") return "https://github.com/example/harness.git\n";
      throw new Error("ETIMEDOUT");
    }) as unknown as typeof execFileSync;

    const result = scanPostMergeBackstop({ repoRoot, now: NOW, execFileSync: run });

    expect(calls.map((call) => call.command)).toEqual(["git", "gh"]);
    expect(calls[1]?.args).toEqual([
      "api",
      "repos/example/harness/pulls?state=closed&base=main&sort=created&direction=asc&per_page=100&page=1",
    ]);
    expect(calls.every((call) => call.options.timeout === POST_MERGE_COMMAND_TIMEOUT_MS)).toBe(
      true,
    );
    expect(result).toMatchObject({ ok: false, pagesScanned: 0 });
    expect(result.unavailableReason).toContain("page_1_fetch_failed:ETIMEDOUT");
  });
  it("U-RVMG-019: default gh adapter は 1 MiB 超の成功応答を受け取れる", () => {
    const repoRoot = root();
    const largeResponse = `${" ".repeat(1024 * 1024 + 1)}[]`;
    const run = ((command: string, _args: readonly string[], options: Record<string, unknown>) => {
      if (command === "git") return "https://github.com/example/harness.git\n";
      expect(options.maxBuffer).toBe(POST_MERGE_GH_MAX_BUFFER_BYTES);
      return largeResponse;
    }) as unknown as typeof execFileSync;

    const result = scanPostMergeBackstop({ repoRoot, now: NOW, execFileSync: run });

    expect(Buffer.byteLength(largeResponse)).toBeGreaterThan(1024 * 1024);
    expect(result).toMatchObject({ ok: true, detections: [], pagesScanned: 1 });
  });

  it("U-RVMG-020: pagination 2 ページ目の失敗は部分結果を green に丸めない", () => {
    const repoRoot = root();
    const result = scan(repoRoot, [], {
      fetch: (page, perPage) => {
        expect(perPage).toBe(MERGED_PR_PAGE_SIZE);
        if (page === 1)
          return Array.from({ length: MERGED_PR_PAGE_SIZE }, (_, index) => merged(520 + index));
        throw new Error("network down");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.unavailableReason).toContain("page_2_fetch_failed");
    expect(formatPostMergeBackstop(result)).toContain("detection unavailable");
  });

  it("U-RVMG-021: 2 ページ目だけにある receipt 無し merge を検知する", () => {
    const repoRoot = root();
    const calls: number[] = [];
    const firstPage = Array.from({ length: MERGED_PR_PAGE_SIZE }, (_, index) =>
      merged(600 + index, "2026-08-14T01:00:00.000Z"),
    );
    const result = scan(repoRoot, [], {
      fetch: (page, perPage) => {
        calls.push(page);
        expect(perPage).toBe(MERGED_PR_PAGE_SIZE);
        return page === 1 ? firstPage : [merged(700)];
      },
    });

    expect(calls).toEqual([1, 2]);
    expect(result.ok).toBe(true);
    expect(result.detections).toContainEqual(
      expect.objectContaining({ reason: "bypass_merge", pr: 700 }),
    );
  });

  it("U-RVMG-022: repeated page と MAX_MERGED_PR_PAGES 到達を bounded traversal で検知不能にする", () => {
    const repoRoot = root();
    const repeated = Array.from({ length: MERGED_PR_PAGE_SIZE }, (_, index) =>
      merged(800 + index, "2026-08-14T01:00:00.000Z"),
    );
    let repeatedCalls = 0;
    const repeatedResult = scan(repoRoot, [], {
      fetch: () => {
        repeatedCalls += 1;
        return repeated;
      },
    });
    expect(repeatedCalls).toBe(2);
    expect(repeatedResult.ok).toBe(false);
    expect(repeatedResult.unavailableReason).toContain("pagination_repeated_page");

    let maxCalls = 0;
    const maxResult = scan(repoRoot, [], {
      fetch: (page) => {
        maxCalls = page;
        return Array.from({ length: MERGED_PR_PAGE_SIZE }, (_, index) =>
          merged(9000 + page * MERGED_PR_PAGE_SIZE + index, "2026-08-14T01:00:00.000Z"),
        );
      },
    });
    expect(maxCalls).toBe(MAX_MERGED_PR_PAGES);
    expect(maxResult.ok).toBe(false);
    expect(maxResult.unavailableReason).toContain(
      `pagination_max_pages_reached:${MAX_MERGED_PR_PAGES}`,
    );
  });

  it("U-RVMG-023: HTTP 成功でも必須 field 欠落 page は検知不能に倒す", () => {
    const repoRoot = root();
    const firstPage = [
      merged(1001),
      ...Array.from({ length: 99 }, (_, index) => merged(1100 + index)),
    ];
    const result = scan(repoRoot, [], {
      fetch: (page) => (page === 1 ? firstPage : [{ number: 2000, merged_at: AFTER_CUTOFF }]),
    });

    expect(result.ok).toBe(false);
    expect(result.detections).toContainEqual(
      expect.objectContaining({ reason: "bypass_merge", pr: 1001 }),
    );
    expect(result.unavailableReason).toContain("required_field_missing_or_invalid");
  });
});
