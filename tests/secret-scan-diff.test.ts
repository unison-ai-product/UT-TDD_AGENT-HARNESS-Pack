import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzePiiScan,
  type BlobReader,
  isWidenedScanSurface,
  type PushedFileEntry,
  resolveScanMode,
  runSecretScanDiff,
} from "../scripts/git-hooks/secret-scan-diff.ts";

const repoRoot = process.cwd();
const hooksDir = join(repoRoot, "scripts", "git-hooks");

/** dummy token は self-trigger 回避のため runtime 連結で生成する (PLAN-L7-260 §2 と同一規律)。 */
function dummyGithubToken(): string {
  return `ghp_${"a".repeat(20)}`;
}
function dummyPhoneNumber(): string {
  return ["090", "1234", "5678"].join("-");
}
function dummyPostalCode(): string {
  return `〒${"123"}-${"4567"}`;
}
function dummyInternalUrl(): string {
  // "example" は secret-scan.ts / secret-scan-diff.ts の ALLOW_LINE_MARKERS に含まれる
  // 許容語のため、実 leak を模す payload では使わない (acme-vendor で代替)。
  return `${["host", "acme-vendor"].join(".")}.internal`;
}
function dummyEmail(): string {
  return ["jane.doe", "@", "acme-vendor", ".com"].join("");
}

/** 実 git blob を読まない純粋 unit test 用の in-memory BlobReader。 */
function fakeBlobReader(store: Record<string, string>): BlobReader {
  return (_root, sha, path) => store[`${sha}:${path}`] ?? null;
}

function gitQ(cwd: string, args: string[], input?: string) {
  return spawnSync("git", args, { cwd, encoding: "utf8", input });
}

function initGitRepo(root: string): void {
  gitQ(root, ["init", "-q"]);
  gitQ(root, ["config", "user.email", "hook-fixture@example.com"]);
  gitQ(root, ["config", "user.name", "hook-fixture"]);
  gitQ(root, ["config", "commit.gpgsign", "false"]);
}

function commitFile(root: string, relPath: string, content: string): string {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  gitQ(root, ["add", relPath]);
  gitQ(root, ["commit", "-q", "-m", "fixture commit"]);
  const rev = gitQ(root, ["rev-parse", "HEAD"]);
  return rev.stdout.trim();
}

/** `scripts/git-hooks/secret-scan-diff.ts` を stdin 経由で直接叩く (CLI entrypoint、実 git blob 使用)。 */
function runHookCli(cwd: string, stdin: string, env?: NodeJS.ProcessEnv) {
  // PLAN-L7-462 step 2: hook 実発火 oracle は node 直 spawn (shell/bun 経由なし)。
  return spawnSync("node", [join(hooksDir, "secret-scan-diff.ts")], {
    cwd,
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, ...env },
    windowsHide: true,
  });
}

describe("isWidenedScanSurface (PLAN-L7-260 §4 対象拡大)", () => {
  it("widens beyond the retired 3-pattern (*CLAUDE.md/*SKILL.md/*/references/*.md) limit", () => {
    expect(isWidenedScanSurface("docs/plans/PLAN-L7-260-x.md")).toBe(true);
    expect(isWidenedScanSurface(".ut-tdd/audit/A-1.md")).toBe(true);
    expect(isWidenedScanSurface(".ut-tdd/logs/foo.json")).toBe(true);
    expect(isWidenedScanSurface(".ut-tdd/memory/foo.md")).toBe(true);
  });

  it("excludes surfaces outside the widened set (e.g. src/, .ut-tdd/handover/)", () => {
    expect(isWidenedScanSurface("src/cli.ts")).toBe(false);
    expect(isWidenedScanSurface(".ut-tdd/handover/CURRENT.json")).toBe(false);
    expect(isWidenedScanSurface("scripts/git-hooks/pre-push")).toBe(false);
  });

  it("normalizes Windows-style backslash separators before matching", () => {
    expect(isWidenedScanSurface(".ut-tdd\\memory\\foo.md")).toBe(true);
  });
});

describe("analyzePiiScan (温存した legacy PII regex: 電話番号/郵便番号/internal URL/email)", () => {
  it("detects all four preserved PII families", () => {
    const text = [dummyPhoneNumber(), dummyPostalCode(), dummyInternalUrl(), dummyEmail()].join(
      "\n",
    );
    const result = analyzePiiScan([{ path: "docs/leak.md", text }]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.marker).sort()).toEqual([
      "email-address",
      "internal-url",
      "phone-number",
      "postal-code",
    ]);
  });

  it("does NOT except dummy/placeholder-labeled lines (legacy PII sensitivity has no such exception)", () => {
    const dummyLabeledLine = `${dummyPhoneNumber()} dummy`;
    const realLine = dummyEmail();
    const result = analyzePiiScan([
      { path: "docs/x.md", text: [dummyLabeledLine, realLine].join("\n") },
    ]);

    expect(result.violations).toEqual([
      { path: "docs/x.md", line: 1, marker: "phone-number" },
      { path: "docs/x.md", line: 2, marker: "email-address" },
    ]);
  });
});

describe("resolveScanMode", () => {
  it("defaults to warn-only when the escalation env var is unset", () => {
    expect(resolveScanMode({})).toBe("warn");
  });

  it("escalates to fail-close only on the exact opt-in value", () => {
    expect(resolveScanMode({ UT_TDD_PRE_PUSH_SECRET_SCAN_MODE: "fail-close" })).toBe("fail-close");
    expect(resolveScanMode({ UT_TDD_PRE_PUSH_SECRET_SCAN_MODE: "block" })).toBe("warn");
  });
});

describe("runSecretScanDiff (secret-scan.ts 再利用 + widened surface filter、in-memory blob)", () => {
  const sha = "deadbeef00000000000000000000000000000000";

  it("passes with no violations when the widened changed-file set is clean", () => {
    const entries: PushedFileEntry[] = [{ sha, path: "docs/ok.md" }];
    const readBlob = fakeBlobReader({ [`${sha}:docs/ok.md`]: "# OK\n" });

    const outcome = runSecretScanDiff(repoRoot, entries, "warn", readBlob);

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
  });

  it("detects a credential marker (reused analyzeSecretScan) in a widened path", () => {
    const entries: PushedFileEntry[] = [{ sha, path: ".ut-tdd/memory/leak.md" }];
    const readBlob = fakeBlobReader({ [`${sha}:.ut-tdd/memory/leak.md`]: dummyGithubToken() });

    const outcome = runSecretScanDiff(repoRoot, entries, "warn", readBlob);

    expect(outcome.ok).toBe(false);
    expect(outcome.messages.join("\n")).toContain("github-token");
    expect(outcome.messages.join("\n")).toContain("warn-only");
    expect(outcome.exitCode).toBe(0);
  });

  it("fail-close mode exits non-zero on the same violation", () => {
    const entries: PushedFileEntry[] = [{ sha, path: ".ut-tdd/audit/leak.md" }];
    const readBlob = fakeBlobReader({ [`${sha}:.ut-tdd/audit/leak.md`]: dummyGithubToken() });

    const outcome = runSecretScanDiff(repoRoot, entries, "fail-close", readBlob);

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.messages.join("\n")).toContain("fail-close");
  });

  it("ignores changed files outside the widened surface even when they contain a leak", () => {
    const entries: PushedFileEntry[] = [{ sha, path: "src/cli.ts" }];
    const readBlob = fakeBlobReader({ [`${sha}:src/cli.ts`]: dummyGithubToken() });

    const outcome = runSecretScanDiff(repoRoot, entries, "fail-close", readBlob);

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
  });

  it("detects the preserved PII regex alongside credential markers in the same widened path", () => {
    const entries: PushedFileEntry[] = [{ sha, path: "docs/plans/leak.md" }];
    const readBlob = fakeBlobReader({ [`${sha}:docs/plans/leak.md`]: dummyEmail() });

    const outcome = runSecretScanDiff(repoRoot, entries, "warn", readBlob);

    expect(outcome.ok).toBe(false);
    expect(outcome.messages.join("\n")).toContain("email-address");
  });

  it("reads each pushed (sha, path) independently — a later clean commit does not hide an earlier leak", () => {
    const shaAdd = "aaaaaaa0000000000000000000000000000000a";
    const shaRemove = "bbbbbbb0000000000000000000000000000000b";
    const entries: PushedFileEntry[] = [
      { sha: shaAdd, path: "docs/leak.md" },
      { sha: shaRemove, path: "docs/leak.md" },
    ];
    const readBlob = fakeBlobReader({
      [`${shaAdd}:docs/leak.md`]: dummyGithubToken(),
      [`${shaRemove}:docs/leak.md`]: "# cleaned\n",
    });

    const outcome = runSecretScanDiff(repoRoot, entries, "fail-close", readBlob);

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(1);
  });
});

describe("secret-scan-diff.ts CLI entrypoint (bun subprocess, stdin 経由, 実 git blob)", () => {
  it("U-DOCSECRET-007: exits 0 and prints a warn-only message for a violation under default mode", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-prepush-cli-warn-"));
    try {
      initGitRepo(root);
      const sha = commitFile(root, "docs/leak.md", dummyGithubToken());

      const run = runHookCli(root, `${sha}\tdocs/leak.md\n`);

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("github-token");
      expect(run.stdout).toContain("warn-only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-DOCSECRET-007: exits non-zero when escalated to fail-close via env var", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-prepush-cli-failclose-"));
    try {
      initGitRepo(root);
      const sha = commitFile(root, "docs/leak.md", dummyGithubToken());

      const run = runHookCli(root, `${sha}\tdocs/leak.md\n`, {
        UT_TDD_PRE_PUSH_SECRET_SCAN_MODE: "fail-close",
      });

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("fail-close");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 0 with an OK message when stdin is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-prepush-cli-empty-"));
    try {
      initGitRepo(root);

      const run = runHookCli(root, "");

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("OK");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-DOCSECRET-007: reads the blob at the given commit, not the current working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-prepush-cli-blob-"));
    try {
      initGitRepo(root);
      const sha = commitFile(root, "docs/leak.md", dummyGithubToken());
      // working tree はクリーン化するが、blob (sha 時点) には secret が残る。
      writeFileSync(join(root, "docs", "leak.md"), "# cleaned on disk\n", "utf8");

      const run = runHookCli(root, `${sha}\tdocs/leak.md\n`, {
        UT_TDD_PRE_PUSH_SECRET_SCAN_MODE: "fail-close",
      });

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("github-token");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scripts/git-hooks/pre-push (shell 経路 e2e、bare remote + hooksPath、Terra 指摘 #3)", () => {
  function pushViaHooksPath(cloneDir: string, env?: NodeJS.ProcessEnv) {
    return spawnSync(
      "git",
      ["-c", `core.hooksPath=${hooksDir}`, "push", "origin", "HEAD:refs/heads/main"],
      {
        cwd: cloneDir,
        encoding: "utf8",
        env: { ...process.env, ...env },
      },
    );
  }

  function setupBareAndClone(): { bareDir: string; cloneDir: string } {
    const workDir = mkdtempSync(join(tmpdir(), "ut-tdd-prepush-e2e-"));
    const bareDir = join(workDir, "remote.git");
    const cloneDir = join(workDir, "clone");
    mkdirSync(bareDir, { recursive: true });
    gitQ(bareDir, ["init", "-q", "--bare"]);
    mkdirSync(cloneDir, { recursive: true });
    initGitRepo(cloneDir);
    gitQ(cloneDir, ["remote", "add", "origin", bareDir]);
    return { bareDir, cloneDir };
  }

  it("blocks (fail-close) when an earlier commit in the same push added a secret later removed by a following commit", () => {
    const { cloneDir } = setupBareAndClone();
    try {
      commitFile(cloneDir, "docs/leak.md", dummyGithubToken());
      commitFile(cloneDir, "docs/leak.md", "# cleaned before push\n");

      const push = pushViaHooksPath(cloneDir, { UT_TDD_PRE_PUSH_SECRET_SCAN_MODE: "fail-close" });

      expect(push.status).not.toBe(0);
      expect(`${push.stdout}${push.stderr}`).toContain("github-token");
    } finally {
      rmSync(join(cloneDir, ".."), { recursive: true, force: true });
    }
  }, 30000);

  it("allows the push (warn-only) by default even with a violation, but still prints the warning", () => {
    const { cloneDir } = setupBareAndClone();
    try {
      commitFile(cloneDir, "docs/leak.md", dummyGithubToken());

      const push = pushViaHooksPath(cloneDir);

      expect(push.status).toBe(0);
      expect(`${push.stdout}${push.stderr}`).toContain("warn-only");
    } finally {
      rmSync(join(cloneDir, ".."), { recursive: true, force: true });
    }
  }, 30000);

  it("allows a clean multi-commit push through with no findings", () => {
    const { cloneDir } = setupBareAndClone();
    try {
      commitFile(cloneDir, "docs/a.md", "# a\n");
      commitFile(cloneDir, "docs/b.md", "# b\n");

      const push = pushViaHooksPath(cloneDir, { UT_TDD_PRE_PUSH_SECRET_SCAN_MODE: "fail-close" });

      expect(push.status).toBe(0);
    } finally {
      rmSync(join(cloneDir, ".."), { recursive: true, force: true });
    }
  }, 30000);
});
