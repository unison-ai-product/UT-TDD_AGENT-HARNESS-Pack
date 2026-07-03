import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditGreenCommandDigests,
  type BlobAtCommit,
  type DigestAuditDeps,
  greenCommandDigestMessages,
  type HistoryScanDeps,
  nodeHistoryScanDeps,
  planDigestMigration,
  toGitPath,
} from "../src/lint/green-command-digest";
import type { GreenCommandEvidence, ParsedReviewPlan } from "../src/lint/review-evidence";

function plan(
  planId: string,
  greenCommands: { evidence_path: string; output_digest: string }[],
): ParsedReviewPlan {
  return {
    file: `docs/plans/${planId}.md`,
    plan_id: planId,
    kind: "impl",
    status: "confirmed",
    updated: "2026-06-23",
    hasEvidence: true,
    crossEntries: [
      {
        review_kind: "intra_runtime_subagent",
        green_commands: greenCommands.map((g) => ({
          kind: "unit_test",
          command: "bun test",
          runner: "bun",
          scope: "targeted",
          exit_code: 0,
          evidence_path: g.evidence_path,
          output_digest: g.output_digest,
        })),
      },
    ],
  };
}

// deterministic fake content store + hash
const STORE: Record<string, string> = {
  "tests/real.test.ts": "real-content",
};
const deps: DigestAuditDeps = {
  readBytes: (p) => (p in STORE ? Buffer.from(STORE[p]) : null),
  // fake hash = "sha256:" + reversed content padded — deterministic, not real sha256, fine for the unit.
  hash: (bytes) => `sha256:${Buffer.from(bytes).toString("hex")}`,
};

describe("green-command-digest (PLAN-L7-132) — digest 実体検査", () => {
  const realDigest = `sha256:${Buffer.from("real-content").toString("hex")}`;

  it("passes when output_digest matches the real hash of evidence_path", () => {
    const mismatches = auditGreenCommandDigests(
      [plan("PLAN-OK", [{ evidence_path: "tests/real.test.ts", output_digest: realDigest }])],
      deps,
    );
    expect(mismatches).toEqual([]);
  });

  it("flags a fake/placeholder digest as digest-mismatch (the L7-110/114 hole)", () => {
    const mismatches = auditGreenCommandDigests(
      [
        plan("PLAN-FAKE", [
          { evidence_path: "tests/real.test.ts", output_digest: "sha256:110feedbac000001" },
        ]),
      ],
      deps,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.reason).toBe("digest-mismatch");
    expect(mismatches[0]?.plan_id).toBe("PLAN-FAKE");
  });

  it("flags a missing evidence_path file", () => {
    const mismatches = auditGreenCommandDigests(
      [
        plan("PLAN-GONE", [
          { evidence_path: "tests/missing.test.ts", output_digest: "sha256:abc123abc123abc1" },
        ]),
      ],
      deps,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.reason).toBe("file-missing");
    expect(mismatches[0]?.actual).toBe("");
  });

  it("skips entries with empty path or digest", () => {
    const mismatches = auditGreenCommandDigests(
      [plan("PLAN-EMPTY", [{ evidence_path: "", output_digest: "" }])],
      deps,
    );
    expect(mismatches).toEqual([]);
  });

  it("renders an OK message when clean and a note when mismatched (non-breaking advisory)", () => {
    expect(greenCommandDigestMessages([])[0]).toContain("OK");
    const note = greenCommandDigestMessages([
      {
        plan_id: "PLAN-FAKE",
        evidence_path: "tests/real.test.ts",
        claimed: "sha256:dead",
        actual: "sha256:beef",
        reason: "digest-mismatch",
      },
    ])[0];
    expect(note).toContain("note:");
    expect(note).toContain("PLAN-FAKE");
  });
});

// --- PLAN-L7-303: anchor_commit 二層照合 ---

function planWithAnchor(planId: string, cmds: Partial<GreenCommandEvidence>[]): ParsedReviewPlan {
  return {
    file: `docs/plans/${planId}.md`,
    plan_id: planId,
    kind: "impl",
    status: "confirmed",
    updated: "2026-07-03",
    hasEvidence: true,
    crossEntries: [
      {
        review_kind: "intra_runtime_subagent",
        green_commands: cmds.map((c) => ({
          kind: "unit_test",
          command: "bun test",
          runner: "bun",
          scope: "targeted",
          exit_code: 0,
          evidence_path: c.evidence_path ?? "tests/real.test.ts",
          output_digest: c.output_digest ?? "",
          ...(c.anchor_commit ? { anchor_commit: c.anchor_commit } : {}),
        })),
      },
    ],
  };
}

const hashOf = (s: string) => `sha256:${Buffer.from(s).toString("hex")}`;
const realSha256Of = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;

describe("green-command-digest anchor 照合 (PLAN-L7-303)", () => {
  // anchor 時点の blob store: commit sha -> path -> content
  const ANCHOR: Record<string, Record<string, string>> = {
    abc123: { "tests/real.test.ts": "content-at-abc" },
  };
  const anchorDeps: DigestAuditDeps = {
    readBytes: (p) => (p in STORE ? Buffer.from(STORE[p]) : null),
    hash: (b) => `sha256:${Buffer.from(b).toString("hex")}`,
    readBlobAtCommit: (sha, p): BlobAtCommit => {
      if (sha === "gone") return { kind: "unverifiable" }; // GC/shallow
      const at = ANCHOR[sha];
      if (!at) return { kind: "unverifiable" };
      if (!(p in at)) return { kind: "missing" };
      return { kind: "bytes", bytes: Buffer.from(at[p]) };
    },
  };

  it("anchor blob と一致すれば working tree が変わっていても green", () => {
    const m = auditGreenCommandDigests(
      [
        planWithAnchor("PLAN-ANCHOR-OK", [
          { output_digest: hashOf("content-at-abc"), anchor_commit: "abc123" },
        ]),
      ],
      anchorDeps,
    );
    expect(m).toEqual([]);
  });

  it("anchor blob と不一致 (捏造) は anchor-digest-mismatch", () => {
    const m = auditGreenCommandDigests(
      [
        planWithAnchor("PLAN-ANCHOR-FAKE", [
          { output_digest: "sha256:deadbeefdeadbeef", anchor_commit: "abc123" },
        ]),
      ],
      anchorDeps,
    );
    expect(m).toHaveLength(1);
    expect(m[0]?.reason).toBe("anchor-digest-mismatch");
  });

  it("anchor commit に path が無ければ anchor-path-missing", () => {
    const m = auditGreenCommandDigests(
      [
        planWithAnchor("PLAN-ANCHOR-GONE-PATH", [
          {
            evidence_path: "tests/other.test.ts",
            output_digest: hashOf("x"),
            anchor_commit: "abc123",
          },
        ]),
      ],
      anchorDeps,
    );
    expect(m).toHaveLength(1);
    expect(m[0]?.reason).toBe("anchor-path-missing");
  });

  it("commit が GC/shallow で取れない (unverifiable) は fail にしない", () => {
    const m = auditGreenCommandDigests(
      [
        planWithAnchor("PLAN-ANCHOR-GC", [
          { output_digest: "sha256:whatever0000", anchor_commit: "gone" },
        ]),
      ],
      anchorDeps,
    );
    expect(m).toEqual([]);
  });

  it("readBlobAtCommit 未提供なら anchor 付き entry も working tree と照合 (完全後方互換)", () => {
    const realDigest = hashOf("real-content");
    const m = auditGreenCommandDigests(
      [
        planWithAnchor("PLAN-ANCHOR-NODEP", [
          { output_digest: realDigest, anchor_commit: "abc123" },
        ]),
      ],
      deps, // readBlobAtCommit 無し
    );
    expect(m).toEqual([]); // working tree の tests/real.test.ts と一致
  });
});

describe("toGitPath (Windows 第一級 — backslash path 誤 suspect 分類の防止)", () => {
  it("backslash を forward slash に正規化する (git pathspec 解決用)", () => {
    expect(toGitPath("tests\\projection-writer.test.ts")).toBe("tests/projection-writer.test.ts");
    expect(toGitPath("src\\schema\\mode-catalog.ts")).toBe("src/schema/mode-catalog.ts");
  });
  it("forward slash はそのまま (POSIX path は不変)", () => {
    expect(toGitPath("tests/real.test.ts")).toBe("tests/real.test.ts");
  });
});

describe("planDigestMigration (PLAN-L7-303 dry-run 計画器)", () => {
  const HISTORY: Record<string, Record<string, string>> = {
    c1: { "tests/real.test.ts": "old-content" },
    c2: { "tests/real.test.ts": "green-content" }, // ここで green だった
    c3: { "tests/real.test.ts": "newer-content" },
  };
  const scanDeps: HistoryScanDeps = {
    commitsTouchingPath: () => ["c3", "c2", "c1"], // 新しい順
    readBlobAtCommit: (sha, p): BlobAtCommit => {
      const at = HISTORY[sha];
      if (!at || !(p in at)) return { kind: "missing" };
      return { kind: "bytes", bytes: Buffer.from(at[p]) };
    },
    hash: (b) => `sha256:${Buffer.from(b).toString("hex")}`,
  };

  it("履歴に claimed 一致 blob があれば recoverable (最新一致 commit を anchor 候補に)", () => {
    const out = planDigestMigration(
      [planWithAnchor("PLAN-REC", [{ output_digest: hashOf("green-content") }])],
      scanDeps,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.disposition).toBe("recoverable");
    expect(out[0]?.anchor_candidate).toBe("c2");
  });

  it("どの commit にも一致 blob が無ければ suspect (捏造/回復不能)", () => {
    const out = planDigestMigration(
      [planWithAnchor("PLAN-SUS", [{ output_digest: "sha256:neverexisted00" }])],
      scanDeps,
    );
    expect(out[0]?.disposition).toBe("suspect");
    expect(out[0]?.anchor_candidate).toBeNull();
  });

  it("既に anchor_commit を持つ entry は already-anchored (移行不要)", () => {
    const out = planDigestMigration(
      [planWithAnchor("PLAN-DONE", [{ output_digest: hashOf("x"), anchor_commit: "c2" }])],
      scanDeps,
    );
    expect(out[0]?.disposition).toBe("already-anchored");
    expect(out[0]?.anchor_candidate).toBe("c2");
  });
});

describe("nodeHistoryScanDeps (git 履歴走査)", () => {
  function git(root: string, args: string[]) {
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  it("Windows backslash evidence_path でも履歴 commit と blob を解決する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-digest-history-"));
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "test@example.com"]);
      git(root, ["config", "user.name", "UT Test"]);
      mkdirSync(join(root, "tests"), { recursive: true });
      const file = join(root, "tests", "real.test.ts");
      writeFileSync(file, "green-content", "utf8");
      git(root, ["add", "tests/real.test.ts"]);
      git(root, ["commit", "-m", "test: add green evidence"]);
      const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();

      const deps = nodeHistoryScanDeps(root);
      const commits = deps.commitsTouchingPath("tests\\real.test.ts");
      const blob = deps.readBlobAtCommit(sha, "tests\\real.test.ts");

      expect(commits).toEqual([sha]);
      expect(blob.kind).toBe("bytes");
      expect(blob.kind === "bytes" ? deps.hash(blob.bytes) : "").toBe(
        realSha256Of("green-content"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
