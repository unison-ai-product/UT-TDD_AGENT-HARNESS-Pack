import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import * as designProtection from "../src/github/design-protection.ts";
import {
  type GitCommandPort,
  GitDiffAdapterError,
  type GitDiffAdapterErrorCode,
} from "../src/github/git-diff.ts";
import { gitTextRaw as git } from "./support/git.ts";
import { removeTestTree } from "./support/temp-tree.ts";

/* Contract-first Red. Module absence is not individual guard mutation evidence. */

/*
 * Contract-first Red: the subject module is intentionally absent in this slice.
 * A module-resolution failure inside it.fails keeps the contract PR green, but is
 * NOT evidence that any individual guard is Red. The implementation PR must run
 * candidate-specific mutation probes before converting these to ordinary tests.
 */

const REPO_ROOT = process.cwd();

const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");

const GIT_BASE = "a".repeat(40);

const GIT_HEAD = "b".repeat(40);

const encoder = new TextEncoder();

type Change =
  | { kind: "added"; path: string }
  | { kind: "modified"; path: string }
  | { kind: "deleted"; path: string }
  | { kind: "renamed"; from: string; path: string };

interface Violation {
  code: string;
  path: string;
  from?: string;
}

interface CheckResult {
  ok: boolean;
  classification: "implementation" | "non-implementation" | "unknown";
  implementationPaths: string[];
  violations: Violation[];
  error?: { code: string; detail: string };
}

interface GitPort extends GitCommandPort {
  calls: string[][];
}

interface GateApi {
  IMPLEMENTATION_PATH_PREFIXES: readonly string[];
  PROTECTED_PATH_PREFIXES: readonly string[];
  classifyPullRequestChanges(
    changes: readonly Change[],
    paths?: { implementation: readonly string[]; protected: readonly string[] },
  ): "implementation" | "non-implementation";
  checkDesignProtection(input: {
    baseRef: string;
    headRef: string;
    git: GitCommandPort;
    paths?: { implementation: readonly string[]; protected: readonly string[] };
  }): CheckResult;
  runDesignProtectionCommand(
    argv: readonly string[],
    deps: { git: GitCommandPort; write: (line: string) => void },
  ): number;
}

async function loadGate(): Promise<GateApi> {
  return designProtection as unknown as GateApi;
}

function nul(...fields: string[]): Uint8Array {
  return encoder.encode(fields.length === 0 ? "" : `${fields.join("\0")}\0`);
}

function diffFor(changes: readonly Change[]): Uint8Array {
  const fields: string[] = [];
  for (const change of changes) {
    if (change.kind === "renamed") fields.push("R100", change.from, change.path);
    else
      fields.push(
        change.kind === "added" ? "A" : change.kind === "modified" ? "M" : "D",
        change.path,
      );
  }
  return nul(...fields);
}

class FakeGit implements GitPort {
  calls: string[][] = [];
  private readonly diff: Uint8Array;
  private readonly diffError?: GitDiffAdapterError;

  constructor(diff: Uint8Array, diffError?: GitDiffAdapterError) {
    this.diff = diff;
    this.diffError = diffError;
  }

  run(args: readonly string[]): Uint8Array {
    this.calls.push([...args]);
    if (args[0] === "rev-parse") {
      return encoder.encode(args.at(-1)?.includes("base") ? `${GIT_BASE}\n` : `${GIT_HEAD}\n`);
    }
    if (args[0] === "diff") {
      if (this.diffError) throw this.diffError;
      return this.diff;
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  }
}

async function check(
  changes: readonly Change[],
  paths?: { implementation: readonly string[]; protected: readonly string[] },
): Promise<CheckResult> {
  const api = await loadGate();
  return api.checkDesignProtection({
    baseRef: "base",
    headRef: "head",
    git: new FakeGit(diffFor(changes)),
    ...(paths ? { paths } : {}),
  });
}

function initRepo(files: Record<string, string>): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-design-protection-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "UT-TDD test");
  for (const [path, content] of Object.entries(files)) writeRepoFile(root, path, content);
  commit(root, "seed");
  return { root, base: git(root, "rev-parse", "HEAD").trim() };
}

function writeRepoFile(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
}

function removeRepo(root: string): void {
  // `root` is always the unique mkdtempSync path created by initRepo or the test.
  removeTestTree(root);
}

function runCli(root: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function requireCliJson(run: ReturnType<typeof runCli>): Record<string, unknown> {
  expect(run.error?.message ?? "", "CLI process must start without a spawn error").toBe("");
  expect(run.stdout.trim(), `stderr:\n${run.stderr}`).not.toBe("");
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function repoState(root: string): string[] {
  return [
    git(root, "rev-parse", "HEAD").trim(),
    git(root, "write-tree").trim(),
    git(root, "status", "--porcelain=v1", "--untracked-files=all"),
    git(root, "count-objects", "-v"),
  ];
}

describe("design-protection contract Red", () => {
  it("U-DPROT-001: implementation PR の design M を拒否する", async () => {
    const result = await check([
      { kind: "modified", path: "src/a.ts" },
      { kind: "modified", path: "docs/design/harness/x.md" },
    ]);
    expect(result).toMatchObject({
      ok: false,
      classification: "implementation",
      violations: [{ code: "protected-modified", path: "docs/design/harness/x.md" }],
    });
  });

  it("U-DPROT-002: implementation PR の design D を拒否する", async () => {
    const result = await check([
      { kind: "modified", path: "src/a.ts" },
      { kind: "deleted", path: "docs/design/harness/x.md" },
    ]);
    expect(result.violations).toEqual([
      expect.objectContaining({ code: "protected-deleted", path: "docs/design/harness/x.md" }),
    ]);
  });

  it("U-DPROT-003: protected design 内外への rename は旧pathを理由に拒否する", async () => {
    const api = await loadGate();
    const cases: Change[][] = [
      [
        { kind: "modified", path: "src/a.ts" },
        { kind: "renamed", from: "docs/design/harness/x.md", path: "docs/design/harness/z.md" },
      ],
      [
        { kind: "modified", path: "src/a.ts" },
        { kind: "renamed", from: "docs/design/harness/x.md", path: "docs/archive/x.md" },
      ],
    ];
    for (const changes of cases) {
      const result = await api.checkDesignProtection({
        baseRef: "base",
        headRef: "head",
        git: new FakeGit(diffFor(changes)),
      });
      expect(result.violations).toContainEqual(
        expect.objectContaining({ code: "protected-renamed", from: "docs/design/harness/x.md" }),
      );
    }
  });

  it("U-DPROT-004: protected への新規追加/外部からのrenameは許可する", async () => {
    const result = await check([
      { kind: "modified", path: "src/a.ts" },
      { kind: "added", path: "docs/design/harness/new.md" },
      { kind: "renamed", from: "docs/archive/old.md", path: "docs/design/harness/moved.md" },
    ]);
    expect(result).toMatchObject({ ok: true, classification: "implementation", violations: [] });
  });

  it("U-DPROT-005: implementation PR の test-design M を拒否する", async () => {
    const result = await check([
      { kind: "modified", path: "src/a.ts" },
      { kind: "modified", path: "docs/test-design/harness/y.md" },
    ]);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: "protected-modified",
        path: "docs/test-design/harness/y.md",
      }),
    );
  });

  it("U-DPROT-006: scripts-only change もimplementationに分類する", async () => {
    const api = await loadGate();
    expect(api.classifyPullRequestChanges([{ kind: "modified", path: "scripts/b.sh" }])).toBe(
      "implementation",
    );
    const result = await api.checkDesignProtection({
      baseRef: "base",
      headRef: "head",
      git: new FakeGit(
        diffFor([
          { kind: "modified", path: "scripts/b.sh" },
          { kind: "modified", path: "docs/design/harness/x.md" },
        ]),
      ),
    });
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "protected-modified", path: "docs/design/harness/x.md" }),
    );
  });

  it("U-DPROT-007: rename from 側のsrc pathもimplementation判定に含める", async () => {
    const api = await loadGate();
    const changes: Change[] = [
      { kind: "renamed", from: "src/a.ts", path: "lib/a.ts" },
      { kind: "modified", path: "docs/design/harness/x.md" },
    ];
    expect(api.classifyPullRequestChanges(changes)).toBe("implementation");
    const result = await api.checkDesignProtection({
      baseRef: "base",
      headRef: "head",
      git: new FakeGit(diffFor(changes)),
    });
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "protected-modified", path: "docs/design/harness/x.md" }),
    );
  });

  it("U-DPROT-008: contract+Red PR のdesign/test-design/tests変更は通す", async () => {
    const result = await check([
      { kind: "modified", path: "docs/design/harness/x.md" },
      { kind: "modified", path: "docs/test-design/harness/y.md" },
      { kind: "deleted", path: "docs/design/harness/old.md" },
      { kind: "added", path: "tests/z.test.ts" },
      { kind: "modified", path: "tests/existing.test.ts" },
    ]);
    expect(result).toMatchObject({
      ok: true,
      classification: "non-implementation",
      violations: [],
    });
  });

  it("U-DPROT-009: non-implementation分類とhooks/workflow非保証境界を保つ", async () => {
    const cases: Change[][] = [
      [
        { kind: "modified", path: "README.md" },
        { kind: "modified", path: ".ut-tdd/memory/m.md" },
      ],
      [
        { kind: "modified", path: ".claude/hooks/work-guard.ts" },
        { kind: "modified", path: "docs/design/harness/x.md" },
      ],
      [
        { kind: "modified", path: ".github/workflows/harness-check.yml" },
        { kind: "modified", path: "docs/test-design/harness/y.md" },
      ],
    ];
    for (const changes of cases) {
      const result = await check(changes);
      expect(result).toMatchObject({
        ok: true,
        classification: "non-implementation",
        violations: [],
      });
    }
  });

  it("U-DPROT-010: 読み取れたempty diffをnon-implementation PASSにする", async () => {
    const result = await check([]);
    expect(result).toMatchObject({
      ok: true,
      classification: "non-implementation",
      implementationPaths: [],
      violations: [],
    });
    expect(result.error).toBeUndefined();
  });

  it("U-DPROT-011: noncanonical pathを拒否しprefix照合はcase-sensitive", async () => {
    const invalid = ["docs\\design\\harness\\x.md", "C:/x", "../x"];
    for (const path of invalid) {
      const result = await check([{ kind: "modified", path }]);
      expect(result).toMatchObject({
        ok: false,
        classification: "unknown",
        error: { code: "git-path-invalid" },
      });
    }
    const caseSensitive = await check([
      { kind: "modified", path: "Docs/Design/x.md" },
      { kind: "modified", path: "SRC/a.ts" },
    ]);
    expect(caseSensitive).toMatchObject({
      ok: true,
      classification: "non-implementation",
      violations: [],
    });
  });

  it("U-DPROT-012: unknown status / malformed NUL / missing rename pathはfail-close", async () => {
    const api = await loadGate();
    const fixtures: Array<[Uint8Array, GitDiffAdapterErrorCode]> = [
      [nul("T", "docs/design/harness/x.md"), "git-status-unknown"],
      [encoder.encode("M\0docs/design/harness/x.md"), "git-diff-malformed"],
      [nul("R100", "docs/design/harness/x.md"), "git-diff-malformed"],
    ];
    for (const [diff, code] of fixtures) {
      const result = await api.checkDesignProtection({
        baseRef: "base",
        headRef: "head",
        git: new FakeGit(diff),
      });
      expect(result).toMatchObject({
        ok: false,
        classification: "unknown",
        error: { code },
        violations: [],
      });
    }
  });

  it("U-DPROT-013: 実CLIがargvで運べるinvalid refをtyped BLOCKにする", () => {
    const { root, base } = initRepo({ "README.md": "seed\n" });
    try {
      const refs = ["refs/heads/nope", "", "bad\tref"];
      for (const ref of refs) {
        const run = runCli(root, [
          "github",
          "design-protection",
          "--base",
          ref,
          "--head",
          base,
          "--json",
        ]);
        expect(run.error?.message ?? "", "production CLI must start").toBe("");
        expect(run.status, `stderr:\n${run.stderr}\nstdout:\n${run.stdout}`).toBe(1);
        expect(requireCliJson(run)).toMatchObject({
          ok: false,
          classification: "unknown",
          error: { code: "git-ref-invalid" },
        });
        const plain = runCli(root, ["github", "design-protection", "--base", ref, "--head", base]);
        expect(plain.error?.message ?? "", "production CLI must start").toBe("");
        expect(plain.status).toBe(1);
        expect(plain.stdout).toContain("design-protection: BLOCK");
      }
    } finally {
      removeRepo(root);
    }
  });

  it("U-DPROT-014: 実CLIはM/D/R違反をJSON/plainで全件path順に返す", () => {
    const { root, base } = initRepo({
      "src/a.ts": "before\n",
      "docs/design/harness/a-modified.md": "before\n",
      "docs/design/harness/b-deleted.md": "delete\n",
      "docs/design/harness/c-renamed.md": "rename\n",
    });
    try {
      writeRepoFile(root, "src/a.ts", "after\n");
      writeRepoFile(root, "docs/design/harness/a-modified.md", "after\n");
      git(root, "rm", "docs/design/harness/b-deleted.md");
      mkdirSync(join(root, "docs/archive"), { recursive: true });
      git(root, "mv", "docs/design/harness/c-renamed.md", "docs/archive/c-renamed.md");
      const head = commit(root, "violating design edits");
      const jsonRun = runCli(root, [
        "github",
        "design-protection",
        "--base",
        base,
        "--head",
        head,
        "--json",
      ]);
      expect(jsonRun.error?.message ?? "", "production CLI must start").toBe("");
      expect(jsonRun.status).toBe(1);
      const result = requireCliJson(jsonRun) as unknown as CheckResult;
      expect(result).toMatchObject({ ok: false, classification: "implementation" });
      expect(result.violations.map((violation) => violation.code).sort()).toEqual([
        "protected-deleted",
        "protected-modified",
        "protected-renamed",
      ]);
      const violationPaths = result.violations.map((violation) => violation.path);
      expect(violationPaths).toEqual(sorted(violationPaths));

      const plainRun = runCli(root, [
        "github",
        "design-protection",
        "--base",
        base,
        "--head",
        head,
      ]);
      expect(plainRun.error?.message ?? "", "production CLI must start").toBe("");
      expect(plainRun.status).toBe(1);
      expect(plainRun.stdout).toContain("design-protection: BLOCK");
      expect(plainRun.stdout).toContain("protected-modified");
      expect(plainRun.stdout).toContain("protected-deleted");
      expect(plainRun.stdout).toContain("protected-renamed");
      expect(plainRun.stdout).toContain("別 PR");
      expect(plainRun.stdout.trim().split(/\r?\n/)).toHaveLength(5);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DPROT-015: change順序とPLANの有無で分類/違反は変わらない", async () => {
    const api = await loadGate();
    const changes: Change[] = [
      { kind: "modified", path: "src/a.ts" },
      { kind: "modified", path: "docs/design/harness/x.md" },
    ];
    const planAdded = [
      ...changes,
      { kind: "added", path: "docs/plans/PLAN-L7-999-order.md" } as const,
    ];
    const resultA = await api.checkDesignProtection({
      baseRef: "base",
      headRef: "head",
      git: new FakeGit(diffFor(changes)),
    });
    const resultB = await api.checkDesignProtection({
      baseRef: "base",
      headRef: "head",
      git: new FakeGit(diffFor([...changes].reverse())),
    });
    const resultWithPlan = await api.checkDesignProtection({
      baseRef: "base",
      headRef: "head",
      git: new FakeGit(diffFor(planAdded)),
    });
    const relevant = (result: CheckResult) => ({
      ok: result.ok,
      classification: result.classification,
      violations: result.violations,
    });
    expect(relevant(resultB)).toEqual(relevant(resultA));
    expect(relevant(resultWithPlan)).toEqual(relevant(resultA));
  });

  it("U-DPROT-017: gate実行とoverride試行はrepo stateを書き換えない", () => {
    const { root, base } = initRepo({
      "src/a.ts": "before\n",
      "docs/design/harness/x.md": "before\n",
    });
    try {
      writeRepoFile(root, "src/a.ts", "after\n");
      writeRepoFile(root, "docs/design/harness/x.md", "after\n");
      const head = commit(root, "protected edit");
      const before = repoState(root);
      const overrideEnv = { ...process.env, UT_TDD_ALLOW_DESIGN_EDIT: "1" };
      const gateRun = runCli(
        root,
        ["github", "design-protection", "--base", base, "--head", head],
        overrideEnv,
      );
      expect(gateRun.error?.message ?? "", "production CLI must start").toBe("");
      expect(gateRun.status).toBe(1);
      expect(gateRun.stdout).toContain("design-protection: BLOCK");
      const allowRun = runCli(root, [
        "github",
        "design-protection",
        "--base",
        base,
        "--head",
        head,
        "--allow",
      ]);
      expect(allowRun.error?.message ?? "", "production CLI must start").toBe("");
      expect(allowRun.status).not.toBe(0);
      const after = repoState(root);
      expect(after).toEqual(before);
    } finally {
      removeRepo(root);
    }
  });

  it("U-DPROT-018: implementation PR のtest-design Dを拒否する", async () => {
    const result = await check([
      { kind: "modified", path: "src/a.ts" },
      { kind: "deleted", path: "docs/test-design/harness/y.md" },
    ]);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "protected-deleted", path: "docs/test-design/harness/y.md" }),
    );
  });

  it("U-DPROT-019: protected test-design 内外へのrenameを拒否する", async () => {
    const api = await loadGate();
    const cases: Change[][] = [
      [
        { kind: "modified", path: "src/a.ts" },
        {
          kind: "renamed",
          from: "docs/test-design/harness/y.md",
          path: "docs/test-design/harness/y2.md",
        },
      ],
      [
        { kind: "modified", path: "src/a.ts" },
        { kind: "renamed", from: "docs/test-design/harness/y.md", path: "docs/archive/y.md" },
      ],
    ];
    for (const changes of cases) {
      const result = await api.checkDesignProtection({
        baseRef: "base",
        headRef: "head",
        git: new FakeGit(diffFor(changes)),
      });
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          code: "protected-renamed",
          from: "docs/test-design/harness/y.md",
        }),
      );
    }
  });

  it("U-DPROT-020: diff失敗はunit結果unknown/git-command-failedでfail-close", async () => {
    const api = await loadGate();
    const result = await api.checkDesignProtection({
      baseRef: "base",
      headRef: "head",
      git: new FakeGit(
        nul(),
        new GitDiffAdapterError("git-command-failed", "fixture diff failure"),
      ),
    });
    expect(result).toMatchObject({
      ok: false,
      classification: "unknown",
      violations: [],
      error: { code: "git-command-failed" },
    });
  });

  it("U-DPROT-021: C75/C90 copy statusはunknownとして拒否する", async () => {
    const api = await loadGate();
    const fixtures = [
      nul("C75", "src/a.ts", "docs/design/harness/c.md"),
      nul("C90", "docs/design/harness/x.md", "docs/design/harness/x-copy.md"),
    ];
    for (const diff of fixtures) {
      const result = await api.checkDesignProtection({
        baseRef: "base",
        headRef: "head",
        git: new FakeGit(diff),
      });
      expect(result).toMatchObject({
        ok: false,
        classification: "unknown",
        violations: [],
        error: { code: "git-status-unknown" },
      });
    }
  });

  it("U-DPROT-022:実gitのmode-only Mは実装PRで拒否しnon-implementationでは許可", () => {
    const { root, base } = initRepo({
      "src/a.ts": "src\n",
      "docs/design/harness/x.md": "unchanged bytes\n",
    });
    try {
      writeRepoFile(root, "src/a.ts", "implementation change\n");
      git(root, "add", "src/a.ts");
      git(root, "update-index", "--chmod=+x", "docs/design/harness/x.md");
      git(root, "commit", "--quiet", "-m", "implementation plus mode-only protected design change");
      const implementationHead = git(root, "rev-parse", "HEAD").trim();
      expect(git(root, "ls-tree", implementationHead, "docs/design/harness/x.md")).toMatch(
        /^100755 blob /,
      );
      const denied = runCli(root, [
        "github",
        "design-protection",
        "--base",
        base,
        "--head",
        implementationHead,
        "--json",
      ]);
      expect(denied.error?.message ?? "", "production CLI must start").toBe("");
      expect(denied.status).toBe(1);
      expect(requireCliJson(denied)).toMatchObject({
        ok: false,
        violations: [expect.objectContaining({ code: "protected-modified" })],
      });

      const { root: nonImplRoot, base: nonImplBase } = initRepo({
        "docs/design/harness/x.md": "unchanged bytes\n",
      });
      try {
        git(nonImplRoot, "update-index", "--chmod=+x", "docs/design/harness/x.md");
        git(nonImplRoot, "commit", "--quiet", "-m", "mode-only non-implementation change");
        const head = git(nonImplRoot, "rev-parse", "HEAD").trim();
        expect(git(nonImplRoot, "ls-tree", head, "docs/design/harness/x.md")).toMatch(
          /^100755 blob /,
        );
        const allowed = runCli(nonImplRoot, [
          "github",
          "design-protection",
          "--base",
          nonImplBase,
          "--head",
          head,
          "--json",
        ]);
        expect(allowed.error?.message ?? "", "production CLI must start").toBe("");
        expect(allowed.status).toBe(0);
        expect(requireCliJson(allowed)).toMatchObject({
          ok: true,
          classification: "non-implementation",
          violations: [],
        });
      } finally {
        removeRepo(nonImplRoot);
      }
    } finally {
      removeRepo(root);
    }
  });

  it("U-DPROT-023: 実gitはbase/headのtwo-point結果でdelete+re-addを正規化する", () => {
    const changed = initRepo({ "src/a.ts": "before\n", "docs/design/harness/x.md": "original\n" });
    try {
      writeRepoFile(changed.root, "src/a.ts", "after\n");
      git(changed.root, "rm", "docs/design/harness/x.md");
      commit(changed.root, "delete design in first commit");
      writeRepoFile(changed.root, "docs/design/harness/x.md", "changed bytes\n");
      const changedHead = commit(changed.root, "re-add changed design");
      const changedRun = runCli(changed.root, [
        "github",
        "design-protection",
        "--base",
        changed.base,
        "--head",
        changedHead,
        "--json",
      ]);
      expect(changedRun.error?.message ?? "", "production CLI must start").toBe("");
      expect(changedRun.status).toBe(1);
      expect(requireCliJson(changedRun)).toMatchObject({
        ok: false,
        violations: [
          expect.objectContaining({ code: "protected-modified", path: "docs/design/harness/x.md" }),
        ],
      });
    } finally {
      removeRepo(changed.root);
    }

    const identical = initRepo({
      "src/a.ts": "before\n",
      "docs/design/harness/x.md": "original\n",
    });
    try {
      writeRepoFile(identical.root, "src/a.ts", "after\n");
      git(identical.root, "rm", "docs/design/harness/x.md");
      commit(identical.root, "delete design in first commit");
      writeRepoFile(identical.root, "docs/design/harness/x.md", "original\n");
      const identicalHead = commit(identical.root, "re-add identical design");
      const identicalRun = runCli(identical.root, [
        "github",
        "design-protection",
        "--base",
        identical.base,
        "--head",
        identicalHead,
        "--json",
      ]);
      expect(identicalRun.error?.message ?? "", "production CLI must start").toBe("");
      expect(identicalRun.status).toBe(0);
      expect(requireCliJson(identicalRun)).toMatchObject({ ok: true, violations: [] });
    } finally {
      removeRepo(identical.root);
    }
  });

  it("U-DPROT-028: injected pathsがclassificationとprotectionの両方を制御する", async () => {
    const paths = { implementation: ["product/"], protected: ["spec/design/"] };
    const blocked = await check(
      [
        { kind: "modified", path: "product/a.ts" },
        { kind: "modified", path: "spec/design/x.md" },
      ],
      paths,
    );
    expect(blocked).toMatchObject({
      ok: false,
      classification: "implementation",
      violations: [{ code: "protected-modified", path: "spec/design/x.md" }],
    });

    const defaultSource = await check(
      [
        { kind: "modified", path: "src/a.ts" },
        { kind: "modified", path: "spec/design/x.md" },
      ],
      paths,
    );
    expect(defaultSource).toMatchObject({
      ok: true,
      classification: "non-implementation",
      violations: [],
    });

    const customSourceDefaultProtected = await check(
      [
        { kind: "modified", path: "product/a.ts" },
        { kind: "modified", path: "docs/design/harness/x.md" },
      ],
      paths,
    );
    expect(customSourceDefaultProtected).toMatchObject({
      ok: true,
      classification: "implementation",
      violations: [],
    });
  });

  it("U-DPROT-029: implementation path外renameを拒否し内側renameとcustom prefixを許可", async () => {
    const api = await loadGate();
    const cases: Array<{
      change: Change;
      paths?: { implementation: readonly string[]; protected: readonly string[] };
      code?: string;
    }> = [
      {
        change: { kind: "renamed", from: "src/a.ts", path: "product/a.ts" },
        code: "implementation-moved-out",
      },
      {
        change: { kind: "renamed", from: "scripts/b.sh", path: "tools/b.sh" },
        code: "implementation-moved-out",
      },
      { change: { kind: "renamed", from: "src/a.ts", path: "src/sub/a.ts" } },
      {
        change: { kind: "renamed", from: "src/a.ts", path: "product/a.ts" },
        paths: {
          implementation: ["src/", "product/"],
          protected: ["docs/design/", "docs/test-design/"],
        },
      },
      {
        change: { kind: "renamed", from: "src/a.ts", path: "docs/design/harness/moved.md" },
        code: "implementation-moved-out",
      },
    ];
    for (const item of cases) {
      const result = await api.checkDesignProtection({
        baseRef: "base",
        headRef: "head",
        git: new FakeGit(diffFor([item.change])),
        ...(item.paths ? { paths: item.paths } : {}),
      });
      if (item.code) {
        expect(result).toMatchObject({ ok: false, classification: "implementation" });
        expect(result.violations).toEqual([
          expect.objectContaining({
            code: item.code,
            path: item.change.path,
            from: item.change.kind === "renamed" ? item.change.from : undefined,
          }),
        ]);
      } else {
        expect(result).toMatchObject({ ok: true, violations: [] });
      }
    }
  });

  it("U-DPROT-031: NUL/LF/CR refはGitCommandPortを呼ぶ前に拒否する", async () => {
    const api = await loadGate();
    for (const baseRef of ["bad\0ref", "bad\nref", "bad\rref"]) {
      const git = new FakeGit(nul());
      const result = await api.checkDesignProtection({ baseRef, headRef: GIT_HEAD, git });
      expect(result).toMatchObject({
        ok: false,
        classification: "unknown",
        error: { code: "git-ref-invalid" },
      });
      expect(git.calls).toEqual([]);
    }
  });

  it("U-DPROT-032: injected CLI handlerはokだけからexit codeとtyped outputを決める", async () => {
    const api = await loadGate();
    const errorGit = new FakeGit(
      nul(),
      new GitDiffAdapterError("git-command-failed", "fixture diff failure"),
    );
    const errorOutput: string[] = [];
    const errorCode = api.runDesignProtectionCommand(["--base", "base", "--head", "head"], {
      git: errorGit,
      write: (line) => errorOutput.push(line),
    });
    expect(errorCode).toBe(1);
    expect(errorOutput.join("\n")).toContain("design-protection: BLOCK");
    expect(errorOutput.join("\n")).toContain("git-command-failed");

    const cleanOutput: string[] = [];
    const cleanCode = api.runDesignProtectionCommand(["--base", "base", "--head", "head"], {
      git: new FakeGit(nul()),
      write: (line) => cleanOutput.push(line),
    });
    expect(cleanCode).toBe(0);
    expect(cleanOutput.join("\n")).toContain("design-protection: PASS");

    const violatingOutput: string[] = [];
    const violatingCode = api.runDesignProtectionCommand(["--base", "base", "--head", "head"], {
      git: new FakeGit(
        diffFor([
          { kind: "modified", path: "src/a.ts" },
          { kind: "modified", path: "docs/design/harness/x.md" },
        ]),
      ),
      write: (line) => violatingOutput.push(line),
    });
    expect(violatingCode).toBe(1);
    expect(violatingOutput.join("\n")).toContain("design-protection: BLOCK");
  });
});
