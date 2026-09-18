import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerLiveReviewCommands, resolveLiveReviewTaskFile } from "../src/cli/review-live.ts";
import { writeMemory } from "../src/memory/service.ts";
import {
  canonicalProjectIdentityBytes,
  loadProjectIdentityFromHead,
} from "../src/plan-asset/adapters/project-identity-loader.ts";
import {
  buildClaudeInboxEntry,
  claudeWorkspaceId,
  publishClaudeInboxEntry,
} from "../src/runtime/claude-memory-wake.ts";
import {
  resolveProjectMemoryRoot,
  resolveProjectMemoryRootWithPorts,
} from "../src/runtime/project-memory-root.ts";

const cliPath = resolve("src/cli.ts");
const fixtures: Array<{ root: string; primary: string; linked: string }> = [];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createLinkedProject(projectId = "example/project-memory-routing"): {
  root: string;
  primary: string;
  linked: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ut-project-memory-routing-"));
  const primary = join(root, "primary");
  const linked = join(root, "linked");
  mkdirSync(primary, { recursive: true });
  git(primary, ["init", "-q", "-b", "main"]);
  git(primary, ["config", "user.email", "test@example.invalid"]);
  git(primary, ["config", "user.name", "UT-TDD Test"]);
  git(primary, ["config", "core.autocrlf", "false"]);
  git(primary, ["remote", "add", "origin", `git@github.com:${projectId}.git`]);
  writeFileSync(join(primary, "ut-tdd.project.json"), canonicalProjectIdentityBytes(projectId));
  writeFileSync(join(primary, "seed.txt"), "seed\n", "utf8");
  git(primary, ["add", "ut-tdd.project.json", "seed.txt"]);
  git(primary, ["commit", "-q", "-m", "test: seed project identity"]);
  git(primary, ["worktree", "add", "-q", "-b", "linked", linked]);
  const fixture = { root, primary, linked };
  fixtures.push(fixture);
  return fixture;
}

function runCli(cwd: string, args: readonly string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: "",
      UT_TDD_PROJECT_DIR: cwd,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (!fixture) continue;
    if (existsSync(fixture.primary)) {
      try {
        git(fixture.primary, ["worktree", "remove", "--force", fixture.linked]);
      } catch {
        // The enclosing temporary repository is removed below.
      }
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("project-scoped Memory routing integration (PLAN-L7-512 Slice 2)", () => {
  it("CANDIDATE-P-PMEMROOT-001: linked Memory CLI writes and reads the primary authored corpus only", () => {
    const { primary, linked } = createLinkedProject();
    const add = runCli(linked, [
      "memory",
      "add",
      "--kind",
      "project",
      "--title",
      "linked canonical routing",
      "--body",
      "written from the linked worktree",
    ]);

    expect({ status: add.status, stderr: add.stderr }).toEqual({ status: 0, stderr: "" });
    const primaryMemory = join(primary, ".ut-tdd", "memory");
    expect(readdirSync(primaryMemory)).toHaveLength(1);
    expect(existsSync(join(linked, ".ut-tdd", "memory"))).toBe(false);

    const list = runCli(linked, ["memory", "list", "--query", "linked canonical routing"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("memory:project:linked-canonical-routing");
  });

  it("CANDIDATE-P-PMEMROOT-001: linked worktrees share project workspace identity and runtime bus", () => {
    const { primary, linked } = createLinkedProject();
    const memory = writeMemory({
      repoRoot: primary,
      input: {
        kind: "project",
        title: "shared wake route",
        body: "shared project wake",
        now: "2026-09-04T00:00:00.000Z",
      },
    });

    const primaryWorkspace = claudeWorkspaceId(primary);
    const linkedWorkspace = claudeWorkspaceId(linked);
    expect(linkedWorkspace).toBe(primaryWorkspace);
    const entry = buildClaudeInboxEntry({
      memory,
      operationId: "linked-shared-wake",
      workspaceId: linkedWorkspace,
      now: "2026-09-04T00:00:01.000Z",
    });
    const linkedPath = publishClaudeInboxEntry(linked, entry);
    const primaryPath = publishClaudeInboxEntry(primary, entry);
    const roots = resolveProjectMemoryRoot(linked);
    expect(roots.ok).toBe(true);
    if (!roots.ok) throw new Error(roots.reason);
    expect(realpathSync.native(linkedPath)).toBe(realpathSync.native(primaryPath));
    expect(linkedPath).toContain(join(roots.runtimeBusRoot, "claude-memory-wake", "inbox"));
  });

  it("CANDIDATE-U-PMEMROOT-002: project identity drift denies wake and review Memory access", () => {
    const { primary, linked } = createLinkedProject();
    writeFileSync(
      join(linked, "ut-tdd.project.json"),
      canonicalProjectIdentityBytes("foreign/project"),
    );
    git(linked, ["add", "ut-tdd.project.json"]);
    git(linked, ["commit", "-q", "-m", "test: drift linked identity"]);

    // The shared loader now rejects origin mismatch before root comparison.
    expect(loadProjectIdentityFromHead({ repoRoot: linked })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_repository_unbound" },
    });
    expect(() => claudeWorkspaceId(linked)).toThrow(
      "project_memory_root_project_identity_unavailable",
    );
    expect(() =>
      resolveLiveReviewTaskFile(linked, {
        memoryId: "memory:project:absent",
        memoryPath: ".ut-tdd/memory/project-absent.md",
      }),
    ).toThrow("project_memory_root_project_identity_unavailable");
    expect(existsSync(join(primary, ".git", "ut-tdd-runtime"))).toBe(false);
  });

  it("CANDIDATE-P-PMEMROOT-001: live review resolves Memory from the primary corpus", async () => {
    const { primary, linked } = createLinkedProject();
    const memory = writeMemory({
      repoRoot: primary,
      input: {
        kind: "feedback",
        title: "linked review task",
        body: "review the linked worktree subject",
        now: "2026-09-04T00:00:00.000Z",
      },
    });
    const task = resolveLiveReviewTaskFile(linked, {
      memoryId: memory.memory_id,
      memoryPath: memory.source_path,
    });
    expect(task).not.toBeNull();
    expect(realpathSync.native(task as string)).toBe(
      realpathSync.native(join(primary, memory.source_path)),
    );

    const program = new Command().exitOverride();
    registerLiveReviewCommands(program.command("review"), {
      repoRoot: () => linked,
      providerAvailable: () => true,
      validateReviewSubject: () => ({ ok: true }),
      resolveWakeTarget: () => ({
        ok: true,
        workspaceId: claudeWorkspaceId(linked),
        sessionId: "claude-session",
      }),
    });
    const originalWrite = process.stdout.write;
    const originalExitCode = process.exitCode;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await program.parseAsync([
        "node",
        "ut-tdd",
        "review",
        "live-dispatch",
        "--memory-id",
        memory.memory_id,
        "--memory-path",
        memory.source_path,
        "--pr",
        "424",
        "--head",
        "a".repeat(40),
        "--revision",
        "issue424-linked-review",
        "--author-family",
        "codex",
        "--json",
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }

    const roots = resolveProjectMemoryRoot(linked);
    expect(roots.ok).toBe(true);
    if (!roots.ok) throw new Error(roots.reason);
    const inbox = join(roots.runtimeBusRoot, "claude-memory-wake", "inbox");
    const envelopes = readdirSync(inbox).filter((name) => name.endsWith(".json"));
    expect(envelopes).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(inbox, envelopes[0]), "utf8"))).toMatchObject({
      memoryId: memory.memory_id,
      targetWorkspaceId: claudeWorkspaceId(primary),
    });
    expect(relative(linked, task as string).startsWith("..")).toBe(true);
  });
});

const win = process.platform === "win32";
const primary = win ? "C:\\dev\\product" : "/dev/product";
const linked = win ? "C:\\dev\\product-worker" : "/dev/product-worker";
const common = win ? `${primary}\\.git` : `${primary}/.git`;

function ports(overrides: Partial<Parameters<typeof resolveProjectMemoryRootWithPorts>[1]> = {}) {
  return {
    gitTopLevel: () => linked,
    gitCommonDir: () => common,
    realpath: (path: string) => path,
    isDirectory: () => true,
    isSafeDescendant: () => true,
    projectIdentity: () => "owner/product",
    ...overrides,
  };
}

function initTrackedProject(root: string, identity = "fixture/project"): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "UT-TDD test"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", `git@github.com:${identity}.git`], { cwd: root });
  writeFileSync(join(root, "ut-tdd.project.json"), canonicalProjectIdentityBytes(identity));
  execFileSync("git", ["add", "ut-tdd.project.json"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture identity"], { cwd: root });
}

describe("project-scoped canonical Memory root (PLAN-L7-512)", () => {
  it("CANDIDATE-U-PMEMROOT-001: linked worktreeをcanonical corpusとproject busへ収束する", () => {
    const result = resolveProjectMemoryRootWithPorts(linked, ports());
    expect(result).toMatchObject({
      ok: true,
      projectId: "owner/product",
      currentWorktreeRoot: linked,
      canonicalProjectRoot: primary,
      gitCommonDir: common,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.authoredMemoryRoot).toBe(
      win ? `${primary}\\.ut-tdd\\memory` : `${primary}/.ut-tdd/memory`,
    );
    expect(result.runtimeBusRoot).toContain(`ut-tdd-runtime${win ? "\\" : "/"}projects`);
    expect(result.runtimeBusRoot.endsWith(result.projectNamespace)).toBe(true);
    expect(result.projectNamespace).toMatch(/^[a-f0-9]{64}$/);
  });

  it("CANDIDATE-U-PMEMROOT-002/003: identity drift・欠落・異常common-dirをtyped denyする", () => {
    expect(
      resolveProjectMemoryRootWithPorts(
        linked,
        ports({ projectIdentity: (root) => (root === linked ? "owner/product" : null) }),
      ),
    ).toEqual({ ok: false, reason: "project_identity_unavailable" });
    expect(
      resolveProjectMemoryRootWithPorts(
        linked,
        ports({ projectIdentity: (root) => (root === linked ? "owner/product" : "owner/other") }),
      ),
    ).toEqual({ ok: false, reason: "project_identity_drift" });
    expect(
      resolveProjectMemoryRootWithPorts(
        linked,
        ports({ gitCommonDir: () => (win ? "C:\\repos\\bare.git" : "/repos/bare.git") }),
      ),
    ).toEqual({ ok: false, reason: "canonical_root_invalid" });
  });

  it("CANDIDATE-U-PMEMROOT-004: 別projectは異なるbus namespaceへ分離する", () => {
    const first = resolveProjectMemoryRootWithPorts(linked, ports());
    const second = resolveProjectMemoryRootWithPorts(
      linked,
      ports({ projectIdentity: () => "owner/other-product" }),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unexpected deny");
    expect(first.projectNamespace).not.toBe(second.projectNamespace);
    expect(first.runtimeBusRoot).not.toBe(second.runtimeBusRoot);
  });

  it("CANDIDATE-U-PMEMROOT-008: authored/runtime rootのpath escapeをfail-closeする", () => {
    expect(
      resolveProjectMemoryRootWithPorts(linked, ports({ isSafeDescendant: () => false })),
    ).toEqual({ ok: false, reason: "authored_memory_root_escape" });
    expect(
      resolveProjectMemoryRootWithPorts(
        linked,
        ports({
          isSafeDescendant: (_root, candidate) => !candidate.includes("ut-tdd-runtime"),
        }),
      ),
    ).toEqual({ ok: false, reason: "runtime_root_escape" });
  });

  it("CANDIDATE-U-PMEMROOT-009: 実gitのcanonical project identityを解決する", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-pmemroot-"));
    const outside = mkdtempSync(join(tmpdir(), "ut-tdd-pmemroot-outside-"));
    try {
      initTrackedProject(root);
      const result = resolveProjectMemoryRoot(root);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.projectId).toBe("fixture/project");
      const canonicalRoot = result.canonicalProjectRoot;
      expect(canonicalRoot.toLowerCase()).toBe(dirname(result.gitCommonDir).toLowerCase());
      expect(result.authoredMemoryRoot.toLowerCase()).toBe(
        join(canonicalRoot, ".ut-tdd", "memory").toLowerCase(),
      );
      expect(result.runtimeBusRoot.toLowerCase()).toContain(
        join(canonicalRoot, ".git", "ut-tdd-runtime", "projects").toLowerCase(),
      );

      // Exercise the production symlink/junction walk instead of replacing the
      // safety port with a fake.  A forged runtime namespace must be denied.
      mkdirSync(dirname(result.runtimeBusRoot), { recursive: true });
      symlinkSync(outside, result.runtimeBusRoot, win ? "junction" : "dir");
      expect(resolveProjectMemoryRoot(root)).toEqual({
        ok: false,
        reason: "runtime_root_escape",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
