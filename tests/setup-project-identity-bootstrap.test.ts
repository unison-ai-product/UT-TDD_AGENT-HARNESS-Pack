import { execFileSync, execSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodePlanRevisionRunner } from "../src/plan-admission/node-plan-revision-runner.ts";
import { buildLegacyPlanInventory } from "../src/plan-asset/adapters/legacy-plan-inventory.ts";
import {
  canonicalProjectIdentityBytes,
  loadProjectIdentityFromHead,
} from "../src/plan-asset/adapters/project-identity-loader.ts";
import { resolveProjectMemoryRoot } from "../src/runtime/project-memory-root.ts";
import {
  bootstrapProjectIdentity,
  repositoryIdentityFromOrigin,
} from "../src/setup/project-identity-bootstrap.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

const fixtures: string[] = [];
const win = process.platform === "win32";
const expectedCandidateIds = new Set([
  ...Array.from(
    { length: 41 },
    (_, index) => `CANDIDATE-U-PROJID-${String(index + 1).padStart(3, "0")}`,
  ),
  "CANDIDATE-P-PROJID-001",
  "CANDIDATE-P-PROJID-002",
  "CANDIDATE-P-PROJID-003",
]);

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(remote = "git@github.com:acme/widget.git"): string {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-project-id-"));
  fixtures.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "UT-TDD test"], { cwd: root });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
  return root;
}

function commitIdentity(root: string, bytes = canonicalProjectIdentityBytes("acme/widget")): void {
  writeFileSync(join(root, "ut-tdd.project.json"), bytes);
  execFileSync("git", ["add", "ut-tdd.project.json"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture identity"], { cwd: root });
}

function trackedFixture(
  identity = "acme/widget",
  remote = `git@github.com:${identity}.git`,
): string {
  const root = fixture(remote);
  commitIdentity(root, canonicalProjectIdentityBytes(identity));
  return root;
}

function windowsShortPath(path: string): string {
  return execSync(`for %I in ("${path}") do @echo %~sI`, {
    encoding: "utf8",
    shell: "cmd.exe",
  })
    .trim()
    .replace(/^"|"$/g, "");
}

describe("project identity bootstrap", () => {
  it("candidate inventory is exact and duplicate-free", () => {
    const source = readFileSync(
      join(headSnapshotRoot(), "tests/setup-project-identity-bootstrap.test.ts"),
      "utf8",
    );
    const ids = [...source.matchAll(/it\("((?:CANDIDATE-U|CANDIDATE-P)-PROJID-\d{3}):/g)].map(
      (match) => match[1],
    );
    expect(ids).toHaveLength(expectedCandidateIds.size);
    expect(new Set(ids)).toEqual(expectedCandidateIds);
  });

  it("bootstrap creates deterministic canonical bytes without committing", () => {
    const root = fixture();
    const result = bootstrapProjectIdentity(root);
    expect(result).toMatchObject({
      ok: true,
      created: true,
      commitRequired: true,
      repositoryIdentity: "acme/widget",
    });
    expect(readFileSync(join(root, "ut-tdd.project.json"))).toEqual(
      Buffer.from(canonicalProjectIdentityBytes("acme/widget")),
    );
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString()).toContain(
      "ut-tdd.project.json",
    );
    expect(statSync(join(root, "ut-tdd.project.json")).isFile()).toBe(true);
    expect(() => execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root })).toThrow();
  });

  it("CANDIDATE-U-PROJID-002: rejects tracked working-tree drift", () => {
    const root = trackedFixture();
    writeFileSync(join(root, "ut-tdd.project.json"), canonicalProjectIdentityBytes("other/repo"));
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_worktree_drift" },
    });
  });

  it("CANDIDATE-U-PROJID-001: HEAD blob receipt is internally complete", () => {
    const root = trackedFixture();
    const result = loadProjectIdentityFromHead({ repoRoot: root });
    expect(result).toMatchObject({
      ok: true,
      value: {
        schemaVersion: "ut-tdd.project/v1",
        repositoryIdentity: "acme/widget",
        provenance: { path: "ut-tdd.project.json", objectFormat: "sha1" },
      },
    });
    if (result.ok) {
      expect(result.value.provenance.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(result.value.provenance.blobOid).toMatch(/^[a-f0-9]{40}$/);
      expect(result.value.provenance.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.value.provenance.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("CANDIDATE-U-PROJID-003: an untracked or absent HEAD entry is missing", () => {
    const root = fixture();
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "plan-repository-identity-missing" },
    });
  });

  it("CANDIDATE-U-PROJID-004: a tracked symlink mode is treated as missing", () => {
    if (win) return;
    const root = fixture();
    const target = join(root, "target.json");
    writeFileSync(target, canonicalProjectIdentityBytes("acme/widget"));
    symlinkSync(target, join(root, "ut-tdd.project.json"));
    execFileSync("git", ["add", "ut-tdd.project.json"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "symlink identity"], { cwd: root });
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "plan-repository-identity-missing" },
    });
  });

  it("CANDIDATE-U-PROJID-005: a later HEAD is read instead of a stale cache", () => {
    const root = trackedFixture();
    const first = loadProjectIdentityFromHead({ repoRoot: root });
    writeFileSync(join(root, "advance"), "advance\n");
    execFileSync("git", ["add", "advance"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "advance"], { cwd: root });
    const second = loadProjectIdentityFromHead({ repoRoot: root });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok)
      expect(second.value.provenance.sourceCommit).not.toBe(first.value.provenance.sourceCommit);
  });

  it("CANDIDATE-U-PROJID-006: duplicate or unexpected JSON keys are invalid", () => {
    const root = fixture();
    commitIdentity(
      root,
      Buffer.from(
        '{"schema_version":"ut-tdd.project/v1","repository_identity":"acme/widget","repository_identity":"acme/widget"}\n',
      ),
    );
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "plan-project-config-invalid" },
    });
  });

  it("CANDIDATE-U-PROJID-007: grammar-invalid repository identity is denied", () => {
    const root = fixture();
    commitIdentity(root, canonicalProjectIdentityBytes("not valid/repository"));
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "plan-repository-identity-invalid" },
    });
  });

  it("CANDIDATE-U-PROJID-008: expected identity mismatch is denied", () => {
    const root = trackedFixture("acme/widget", "");
    expect(
      loadProjectIdentityFromHead({ repoRoot: root, expectedRepositoryIdentity: "other/repo" }),
    ).toMatchObject({ ok: false, error: { ruleId: "plan-repository-identity-missing" } });
  });

  it("CANDIDATE-U-PROJID-009: UTF-8 BOM bytes are noncanonical", () => {
    const root = fixture();
    commitIdentity(
      root,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(canonicalProjectIdentityBytes("acme/widget")),
      ]),
    );
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_noncanonical_bytes" },
    });
  });

  it("CANDIDATE-U-PROJID-010: valid CRLF JSON is denied by canonical bytes", () => {
    const root = fixture();
    commitIdentity(
      root,
      Buffer.from(
        '{\r\n  "schema_version":"ut-tdd.project/v1",\r\n  "repository_identity":"acme/widget"\r\n}\r\n',
      ),
    );
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_noncanonical_bytes" },
    });
  });

  it("normalizes SSH origin to owner/repository", () => {
    expect(repositoryIdentityFromOrigin(fixture("git@github.com:owner/repository.git"))).toBe(
      "owner/repository",
    );
  });

  it("normalizes HTTPS origin to owner/repository", () => {
    expect(repositoryIdentityFromOrigin(fixture("https://github.com/owner/repository.git"))).toBe(
      "owner/repository",
    );
  });

  it("rejects malformed origin", () => {
    expect(repositoryIdentityFromOrigin(fixture("https://github.com/owner/a/b.git"))).toBeNull();
  });

  it("missing origin is a typed bootstrap denial", () => {
    const root = fixture("");
    expect(bootstrapProjectIdentity(root)).toMatchObject({
      ok: false,
      error: { ruleId: "identity_repository_unbound" },
    });
    expect(() => readFileSync(join(root, "ut-tdd.project.json"))).toThrow();
  });

  it("CANDIDATE-U-PROJID-028: preserves stale untracked identity", () => {
    const root = fixture();
    const path = join(root, "ut-tdd.project.json");
    writeFileSync(
      path,
      Buffer.from('{"schema_version":"ut-tdd.project/v1","repository_identity":"other/repo"}'),
    );
    expect(bootstrapProjectIdentity(root)).toMatchObject({
      ok: false,
      error: { ruleId: "identity_stale_worktree" },
    });
    expect(readFileSync(path, "utf8")).toContain("other/repo");
  });

  it("rejects an identity path symlink", () => {
    if (win) return;
    const root = fixture();
    const target = join(root, "elsewhere.json");
    writeFileSync(target, canonicalProjectIdentityBytes("acme/widget"));
    symlinkSync(target, join(root, "ut-tdd.project.json"));
    expect(bootstrapProjectIdentity(root)).toMatchObject({
      ok: false,
      error: { ruleId: "identity_stale_worktree" },
    });
  });

  it("does not implicitly add or commit", () => {
    const root = fixture();
    expect(bootstrapProjectIdentity(root)).toMatchObject({ ok: true, created: true });
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root }).toString()).toBe(
      "",
    );
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString()).toContain(
      "?? ut-tdd.project.json",
    );
  });

  it("CANDIDATE-U-PROJID-024: canonical output is LF UTF-8 without BOM", () => {
    const bytes = Buffer.from(canonicalProjectIdentityBytes("acme/widget"));
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes.toString("utf8").endsWith("\n")).toBe(true);
  });

  it("CANDIDATE-U-PROJID-011: create accepts SSH origin", () => {
    expect(bootstrapProjectIdentity(fixture("git@github.com:acme/widget.git"))).toMatchObject({
      ok: true,
      repositoryIdentity: "acme/widget",
    });
  });

  it("CANDIDATE-U-PROJID-012: create accepts HTTPS origin", () => {
    expect(bootstrapProjectIdentity(fixture("https://github.com/acme/widget.git"))).toMatchObject({
      ok: true,
      repositoryIdentity: "acme/widget",
    });
  });

  it("CANDIDATE-U-PROJID-013: create denies an origin-less repository", () => {
    expect(bootstrapProjectIdentity(fixture(""))).toMatchObject({
      ok: false,
      error: { ruleId: "identity_repository_unbound" },
    });
  });

  it("CANDIDATE-U-PROJID-014: create denies malformed origin", () => {
    expect(bootstrapProjectIdentity(fixture("not-a-repository-url"))).toMatchObject({
      ok: false,
      error: { ruleId: "identity_repository_unbound" },
    });
  });

  it("CANDIDATE-U-PROJID-015: repeated create is byte deterministic", () => {
    const root = fixture();
    const first = bootstrapProjectIdentity(root);
    const before = readFileSync(join(root, "ut-tdd.project.json"));
    const second = bootstrapProjectIdentity(root);
    expect(first).toMatchObject({ ok: true, created: true, commitRequired: true });
    expect(second).toMatchObject({ ok: true, created: false, commitRequired: true });
    expect(readFileSync(join(root, "ut-tdd.project.json"))).toEqual(before);
  });

  it("CANDIDATE-U-PROJID-016: tracked rerun reads HEAD and does not rewrite", () => {
    const root = trackedFixture();
    const before = readFileSync(join(root, "ut-tdd.project.json"));
    expect(bootstrapProjectIdentity(root)).toMatchObject({
      ok: true,
      created: false,
      commitRequired: false,
    });
    expect(readFileSync(join(root, "ut-tdd.project.json"))).toEqual(before);
  });

  it("CANDIDATE-U-PROJID-017: read-only HEAD loader never creates a missing file", () => {
    const root = fixture();
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "plan-repository-identity-missing" },
    });
    expect(() => readFileSync(join(root, "ut-tdd.project.json"))).toThrow();
  });

  it("CANDIDATE-U-PROJID-018: reuses canonical untracked identity with explicit commit-required state", () => {
    const root = fixture();
    bootstrapProjectIdentity(root);
    expect(bootstrapProjectIdentity(root)).toMatchObject({
      ok: true,
      created: false,
      commitRequired: true,
    });
  });

  it("CANDIDATE-U-PROJID-019: explicit commit changes bootstrap from create to tracked read", () => {
    const root = fixture();
    expect(bootstrapProjectIdentity(root)).toMatchObject({ ok: true, commitRequired: true });
    commitIdentity(root);
    expect(bootstrapProjectIdentity(root)).toMatchObject({ ok: true, commitRequired: false });
  });

  it("CANDIDATE-U-PROJID-020: identity is independent of absolute checkout path", () => {
    const root = trackedFixture();
    const moved = `${root}-moved`;
    renameSync(root, moved);
    fixtures[fixtures.indexOf(root)] = moved;
    expect(loadProjectIdentityFromHead({ repoRoot: moved })).toMatchObject({
      ok: true,
      value: { repositoryIdentity: "acme/widget" },
    });
  });

  it("CANDIDATE-U-PROJID-021: linked worktree keeps the same tracked identity", () => {
    const root = trackedFixture();
    const linked = `${root}-linked`;
    fixtures.push(linked);
    execFileSync("git", ["worktree", "add", "-q", "--detach", linked], { cwd: root });
    expect(loadProjectIdentityFromHead({ repoRoot: linked })).toMatchObject({
      ok: true,
      value: { repositoryIdentity: "acme/widget" },
    });
    execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: root });
  });

  it("CANDIDATE-U-PROJID-022: moving a checkout preserves identity and receipt semantics", () => {
    const root = trackedFixture();
    const before = loadProjectIdentityFromHead({ repoRoot: root });
    const moved = `${root}-moved`;
    renameSync(root, moved);
    fixtures[fixtures.indexOf(root)] = moved;
    const after = loadProjectIdentityFromHead({ repoRoot: moved });
    expect(after).toMatchObject({ ok: true, value: { repositoryIdentity: "acme/widget" } });
    if (before.ok && after.ok)
      expect(after.value.provenance.blobOid).toBe(before.value.provenance.blobOid);
  });

  it("CANDIDATE-U-PROJID-023: namespace inputs remain distinct for distinct identities", () => {
    const first = trackedFixture("acme/widget");
    const second = trackedFixture("acme/other");
    expect(loadProjectIdentityFromHead({ repoRoot: first })).toMatchObject({
      value: { repositoryIdentity: "acme/widget" },
    });
    expect(loadProjectIdentityFromHead({ repoRoot: second })).toMatchObject({
      value: { repositoryIdentity: "acme/other" },
    });
  });

  it("CANDIDATE-U-PROJID-025: an OS-resolved 8.3 path preserves identity", () => {
    if (!win) return;
    const root = trackedFixture();
    const alternate = windowsShortPath(root);
    expect(alternate).not.toBe("");
    expect(alternate.toLowerCase()).not.toBe(root.toLowerCase());
    expect(repositoryIdentityFromOrigin(root)).toBe("acme/widget");
    expect(repositoryIdentityFromOrigin(alternate)).toBe("acme/widget");
  });

  it("CANDIDATE-U-PROJID-026: path spelling does not enter the identity bytes", () => {
    const root = fixture();
    const first = bootstrapProjectIdentity(root);
    const alternate = win ? root.toUpperCase() : root;
    const second = bootstrapProjectIdentity(alternate);
    expect(first).toMatchObject({ ok: true, repositoryIdentity: "acme/widget" });
    expect(second).toMatchObject({ ok: true, repositoryIdentity: "acme/widget" });
    expect(readFileSync(join(root, "ut-tdd.project.json"))).toEqual(
      canonicalProjectIdentityBytes("acme/widget"),
    );
  });

  it("committed CRLF bytes are rejected as noncanonical", () => {
    const root = fixture();
    const crlf = Buffer.from(
      '{\r\n  "schema_version": "ut-tdd.project/v1",\r\n  "repository_identity": "acme/widget"\r\n}\r\n',
    );
    commitIdentity(root, crlf);
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_noncanonical_bytes" },
    });
  });

  it("committed alternate key order is rejected as noncanonical", () => {
    const root = fixture();
    const reordered = Buffer.from(
      '{\n  "repository_identity": "acme/widget",\n  "schema_version": "ut-tdd.project/v1"\n}\n',
    );
    commitIdentity(root, reordered);
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_noncanonical_bytes" },
    });
  });

  it("invalid identity grammar is denied", () => {
    const root = fixture();
    commitIdentity(root, canonicalProjectIdentityBytes("not valid/repository"));
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "plan-repository-identity-invalid" },
    });
  });

  it("CANDIDATE-U-PROJID-027: tracked identity must match origin binding", () => {
    const root = trackedFixture("other/repo", "git@github.com:acme/widget.git");
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_repository_unbound" },
    });
  });

  it("deleting a tracked file is typed worktree drift", () => {
    const root = trackedFixture();
    unlinkSync(join(root, "ut-tdd.project.json"));
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_worktree_drift" },
    });
  });

  it("CANDIDATE-U-PROJID-029: a resolvable junction repository root preserves identity", () => {
    const root = trackedFixture();
    const link = `${root}-root-link`;
    fixtures.push(link);
    symlinkSync(root, link, win ? "junction" : "dir");
    expect(loadProjectIdentityFromHead({ repoRoot: link })).toMatchObject({
      ok: true,
      value: { repositoryIdentity: "acme/widget" },
    });
  });

  it("CANDIDATE-U-PROJID-030: loader has no directory-name fallback", () => {
    const root = fixture("");
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "plan-repository-identity-missing" },
    });
  });

  it("CANDIDATE-U-PROJID-031: receipt is freshly bound to the current HEAD", () => {
    const root = trackedFixture();
    writeFileSync(join(root, "marker"), "marker\n");
    execFileSync("git", ["add", "marker"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "advance HEAD"], { cwd: root });
    const laterCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
    execFileSync("git", ["reset", "--hard", "HEAD^"], { cwd: root });
    expect(
      loadProjectIdentityFromHead({
        repoRoot: root,
        afterHeadResolved: ({ repoRoot }) => {
          // Move the branch ref from the resolved subject to a different
          // commit without changing the checked-out bytes. This is an actual
          // second-process-equivalent ref mutation between resolve and show;
          // the loader must fail before it can return a mixed receipt.
          execFileSync("git", ["update-ref", "refs/heads/main", laterCommit], { cwd: repoRoot });
        },
      }),
    ).toMatchObject({ ok: false, error: { ruleId: "identity_head_toctou" } });
  });

  it("CANDIDATE-U-PROJID-032: deleting tracked identity denies before parsing", () => {
    const root = trackedFixture();
    unlinkSync(join(root, "ut-tdd.project.json"));
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_worktree_drift" },
    });
  });

  it("CANDIDATE-U-PROJID-033: identical worktree bytes are accepted", () => {
    const root = trackedFixture();
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: true,
      value: { repositoryIdentity: "acme/widget" },
    });
  });

  it("CANDIDATE-U-PROJID-034: CRLF committed identity is denied", () => {
    const root = fixture();
    commitIdentity(
      root,
      Buffer.from(
        '{\r\n  "schema_version":"ut-tdd.project/v1",\r\n  "repository_identity":"acme/widget"\r\n}\r\n',
      ),
    );
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_noncanonical_bytes" },
    });
  });

  it("CANDIDATE-U-PROJID-035: key order variation is denied", () => {
    const root = fixture();
    commitIdentity(
      root,
      Buffer.from('{"repository_identity":"acme/widget","schema_version":"ut-tdd.project/v1"}\n'),
    );
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_noncanonical_bytes" },
    });
  });

  it("CANDIDATE-U-PROJID-036: node revision runner's direct identity reader is origin-bound", () => {
    const root = trackedFixture("other/repo", "git@github.com:acme/widget.git");
    const runner = createNodePlanRevisionRunner(root) as unknown as {
      deps: { repositoryIdentity: () => string };
    };
    expect(() => runner.deps.repositoryIdentity()).toThrow("identity_repository_unbound");
  });

  it("CANDIDATE-U-PROJID-037: legacy inventory direct caller denies stale identity", () => {
    const root = trackedFixture("other/repo", "git@github.com:acme/widget.git");
    expect(buildLegacyPlanInventory(root)).toMatchObject({
      ok: false,
      error: { ruleId: "identity_repository_unbound" },
    });
  });

  it("CANDIDATE-U-PROJID-038: project-memory direct caller denies stale identity", () => {
    const root = trackedFixture("other/repo", "git@github.com:acme/widget.git");
    expect(resolveProjectMemoryRoot(root)).toEqual({
      ok: false,
      reason: "project_identity_unavailable",
    });
  });

  it("CANDIDATE-U-PROJID-039: tracked identity without origin is unbound", () => {
    const root = trackedFixture("acme/widget", "git@github.com:acme/widget.git");
    execFileSync("git", ["remote", "remove", "origin"], { cwd: root });
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "identity_repository_unbound" },
    });
  });

  it("CANDIDATE-U-PROJID-040: a local snapshot origin resolves exactly one Git custody hop", () => {
    const source = trackedFixture();
    const clone = `${source}-snapshot`;
    fixtures.push(clone);
    execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", source, clone]);
    expect(repositoryIdentityFromOrigin(clone)).toBe("acme/widget");
    expect(loadProjectIdentityFromHead({ repoRoot: clone })).toMatchObject({
      ok: true,
      value: { repositoryIdentity: "acme/widget" },
    });

    const cloneOfClone = `${clone}-nested`;
    fixtures.push(cloneOfClone);
    execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", clone, cloneOfClone]);
    expect(repositoryIdentityFromOrigin(cloneOfClone)).toBeNull();

    const originlessSource = trackedFixture("acme/widget", "");
    const originlessSnapshot = `${originlessSource}-snapshot`;
    fixtures.push(originlessSnapshot);
    execFileSync("git", [
      "clone",
      "-q",
      "-c",
      "core.autocrlf=false",
      originlessSource,
      originlessSnapshot,
    ]);
    expect(repositoryIdentityFromOrigin(originlessSnapshot)).toBeNull();
  });

  it("CANDIDATE-U-PROJID-041: conflicting origin and explicit identity is unbound", () => {
    const root = trackedFixture();
    expect(
      loadProjectIdentityFromHead({ repoRoot: root, expectedRepositoryIdentity: "other/repo" }),
    ).toMatchObject({ ok: false, error: { ruleId: "identity_repository_unbound" } });
  });

  it("CANDIDATE-P-PROJID-001: the harness identity equals canonical origin-derived bytes", () => {
    const harnessSnapshotRoot = headSnapshotRoot();
    const expected = "unison-ai-product/UT-TDD_AGENT-HARNESS";
    expect(readFileSync(join(harnessSnapshotRoot, "ut-tdd.project.json"))).toEqual(
      Buffer.from(canonicalProjectIdentityBytes(expected)),
    );
    expect(
      loadProjectIdentityFromHead({
        repoRoot: harnessSnapshotRoot,
        expectedRepositoryIdentity: expected,
      }),
    ).toMatchObject({
      ok: true,
      value: { repositoryIdentity: expected },
    });
  });

  it("CANDIDATE-P-PROJID-002: explicit commit is the only authority transition", () => {
    const root = fixture();
    expect(bootstrapProjectIdentity(root)).toMatchObject({ ok: true, commitRequired: true });
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({
      ok: false,
      error: { ruleId: "plan-repository-identity-missing" },
    });
    commitIdentity(root);
    expect(loadProjectIdentityFromHead({ repoRoot: root })).toMatchObject({ ok: true });
  });

  it("CANDIDATE-P-PROJID-003: a real junction path preserves canonical identity", () => {
    const root = trackedFixture();
    const linked = `${root}-junction`;
    fixtures.push(linked);
    symlinkSync(root, linked, win ? "junction" : "dir");
    expect(repositoryIdentityFromOrigin(linked)).toBe("acme/widget");
    expect(loadProjectIdentityFromHead({ repoRoot: linked })).toMatchObject({
      value: { repositoryIdentity: "acme/widget" },
    });
  });
});
