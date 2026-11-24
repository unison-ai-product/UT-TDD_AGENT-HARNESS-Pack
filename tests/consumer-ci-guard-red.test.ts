import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { workspaceRead } from "./support/workspace-roots.ts";

type GuardResult = {
  ok: boolean;
  findings: Array<{ code: string; evidence: string }>;
};
type GitFixture = { root: string; cleanup: () => void };
type GuardArgs = { baseRef?: string; prTitle?: string; commitFile?: string };
type Capture = {
  error?: string;
  fixture?: GitFixture;
  facts?: Record<string, unknown>;
  child?: SpawnSyncReturns<string>;
};

// The runner executes tests from its npm-ci snapshot; headSnapshotRoot() is a
// separate read-only reference clone and intentionally has no installed deps.
const harnessRoot = workspaceRead({
  id: "consumer-ci-guard-cli-root",
  mode: "isolated_fixture",
  reason:
    "CLI E2E must use the npm-ci execution snapshot, not the detached read-only reference clone",
  root: process.cwd(),
});
const cliPath = join(harnessRoot, "src", "cli.ts");
const captures = new Map<string, Capture>();
const fixtures: GitFixture[] = [];
let preconditionsVerified = false;
let spawnsVerified = false;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function commit(root: string, file: string, contents: string, subject: string): void {
  writeFileSync(join(root, file), contents, "utf8");
  git(root, "add", file);
  git(root, "commit", "--quiet", "-m", subject);
}

function createFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "ut-tdd-guard-"));
  const fixture = { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  fixtures.push(fixture);
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.name", "UT-TDD fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  commit(root, "base.txt", "base\n", "chore: fixture base");
  return fixture;
}

function rangeSubjects(root: string, base = "main"): string[] {
  return git(root, "log", "--reverse", "--format=%s", `${base}..HEAD`)
    .split(/\r?\n/)
    .filter(Boolean);
}

function mergedFixture(subject: string): { fixture: GitFixture; subjects: string[] } {
  const fixture = createFixture();
  git(fixture.root, "checkout", "--quiet", "-b", "feature/guard-fixture");
  commit(fixture.root, "feature.txt", "feature\n", subject);
  git(fixture.root, "checkout", "--quiet", "-b", "side", "main");
  commit(fixture.root, "side.txt", "side\n", "chore: side fixture");
  git(fixture.root, "checkout", "--quiet", "feature/guard-fixture");
  git(fixture.root, "merge", "--quiet", "--no-ff", "side", "-m", "Merge side fixture");
  return { fixture, subjects: rangeSubjects(fixture.root) };
}

function spawnGuard(fixture: GitFixture, options: GuardArgs = {}): SpawnSyncReturns<string> {
  const args = [
    cliPath,
    "github",
    "guard",
    "--head-ref",
    "feature/guard-fixture",
    "--base-ref",
    options.baseRef ?? "main",
    "--json",
  ];
  if (options.prTitle !== undefined) args.push("--pr-title", options.prTitle);
  if (options.commitFile !== undefined) args.push("--commit-file", options.commitFile);
  return spawnSync(process.execPath, args, {
    cwd: fixture.root,
    encoding: "utf8",
    windowsHide: true,
  });
}

function capture(
  key: string,
  setup: () => { fixture: GitFixture; facts: Record<string, unknown>; args?: GuardArgs },
): void {
  try {
    const { fixture, facts, args } = setup();
    captures.set(key, { fixture, facts, child: spawnGuard(fixture, args) });
  } catch (error) {
    captures.set(key, {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
}

function captureFor(key: string): Capture {
  return captures.get(key) ?? { error: `missing capture: ${key}` };
}

function ready(key: string): boolean {
  const current = captureFor(key);
  if (
    !preconditionsVerified ||
    !spawnsVerified ||
    current.error ||
    !current.facts ||
    !current.child ||
    current.child.error ||
    current.child.status === null
  )
    return false;
  try {
    const result = JSON.parse(current.child.stdout) as GuardResult;
    return typeof result.ok === "boolean" && Array.isArray(result.findings);
  } catch {
    return false;
  }
}

function result(key: string): { status: number | null; body: GuardResult } {
  const child = captureFor(key).child;
  if (!child) throw new Error(`missing guard spawn: ${key}`);
  return { status: child.status, body: JSON.parse(child.stdout) as GuardResult };
}

function prepareCases006To009(): void {
  capture("006", () => {
    const { fixture, subjects } = mergedFixture("bad commit message");
    return {
      fixture,
      facts: {
        badSubjectInRange: subjects.includes("bad commit message"),
        mergeSubjectInRange: subjects.some((subject) => subject.startsWith("Merge ")),
      },
    };
  });

  capture("007", () => {
    const fixture = createFixture();
    git(fixture.root, "checkout", "--quiet", "-b", "feature/guard-fixture");
    const title = "Merge pull request from feature/guard-fixture";
    return {
      fixture,
      args: { prTitle: title },
      facts: {
        mergePrefixed: title.startsWith("Merge "),
        titleIsNonConventional: !/^\w+(?:\([^)]*\))?!?: .+$/.test(title),
      },
    };
  });

  capture("008-valid", () => {
    const { fixture, subjects } = mergedFixture("feat: add fixture feature");
    return {
      fixture,
      facts: {
        validFeatureInRange: subjects.includes("feat: add fixture feature"),
        validSideInRange: subjects.includes("chore: side fixture"),
        mergeSubjectInRange: subjects.some((subject) => subject.startsWith("Merge ")),
      },
    };
  });
  capture("008-invalid-control", () => {
    const { fixture, subjects } = mergedFixture("bad control commit message");
    return {
      fixture,
      facts: {
        invalidSubjectInRange: subjects.includes("bad control commit message"),
        mergeSubjectInRange: subjects.some((subject) => subject.startsWith("Merge ")),
      },
    };
  });

  capture("009", () => {
    const fixture = createFixture();
    git(fixture.root, "checkout", "--quiet", "-b", "feature/guard-fixture");
    const missingRef = "missing/base-ref";
    let refMissing = false;
    try {
      git(fixture.root, "rev-parse", "--verify", missingRef);
    } catch {
      refMissing = true;
    }
    return { fixture, args: { baseRef: missingRef }, facts: { refMissing } };
  });
}

function prepareCase010(): void {
  capture("010", () => {
    const fixture = createFixture();
    git(fixture.root, "checkout", "--quiet", "-b", "feature/guard-fixture");
    const file = join(fixture.root, "explicit-subjects.txt");
    writeFileSync(file, "bad commit message\n", "utf8");
    return {
      fixture,
      args: { commitFile: file },
      facts: { fileContents: readFileSync(file, "utf8"), fileExists: true },
    };
  });
}

function prepareCases015And016(): void {
  capture("015", () => {
    const fixture = createFixture();
    git(fixture.root, "checkout", "--quiet", "-b", "feature/guard-fixture");
    commit(fixture.root, "change-0.txt", "0\n", "bad oldest subject");
    for (let index = 1; index <= 25; index += 1) {
      commit(fixture.root, `change-${index}.txt`, `${index}\n`, `chore: fixture change ${index}`);
    }
    const subjects = rangeSubjects(fixture.root);
    return {
      fixture,
      facts: { rangeLength: subjects.length, oldestSubject: subjects[0] },
    };
  });

  capture("016-valid", () => {
    const fixture = createFixture();
    commit(fixture.root, "old-invalid.txt", "old\n", "bad pre-branch subject");
    const mergeBase = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "checkout", "--quiet", "-b", "feature/guard-fixture");
    commit(fixture.root, "feature.txt", "feature\n", "feat: valid feature commit");
    return {
      fixture,
      facts: {
        invalidCommitOnBase: git(fixture.root, "log", "--format=%s", "main").includes(
          "bad pre-branch subject",
        ),
        mergeBaseUnchanged: git(fixture.root, "merge-base", "main", "HEAD") === mergeBase,
        rangeSubjects: rangeSubjects(fixture.root),
      },
    };
  });
  capture("016-invalid-control", () => {
    const fixture = createFixture();
    git(fixture.root, "checkout", "--quiet", "-b", "feature/guard-fixture");
    commit(fixture.root, "invalid.txt", "invalid\n", "bad in-range subject");
    commit(fixture.root, "valid.txt", "valid\n", "feat: valid follow-up");
    return { fixture, facts: { rangeSubjects: rangeSubjects(fixture.root) } };
  });
}

function prepareCase017(): void {
  capture("017-origin", () => {
    const fixture = createFixture();
    git(fixture.root, "checkout", "--quiet", "-b", "base-advance");
    commit(fixture.root, "base-invalid.txt", "base\n", "bad remote base subject");
    const remoteBase = git(fixture.root, "rev-parse", "HEAD");
    git(fixture.root, "update-ref", "refs/remotes/origin/main", remoteBase);
    git(fixture.root, "checkout", "--quiet", "-b", "feature/guard-fixture");
    commit(fixture.root, "feature.txt", "feature\n", "feat: valid feature commit");
    const localRange = rangeSubjects(fixture.root, "main");
    const remoteRange = rangeSubjects(fixture.root, "origin/main");
    return {
      fixture,
      facts: {
        localRange,
        remoteRange,
        remoteBaseExists: git(fixture.root, "rev-parse", "--verify", "origin/main").length > 0,
      },
    };
  });
  capture("017-local-control", () => {
    const prior = captureFor("017-origin");
    if (prior.error || !prior.facts || !prior.fixture)
      throw new Error("origin-preferred fixture setup failed");
    const fixture = prior.fixture;
    git(fixture.root, "update-ref", "-d", "refs/remotes/origin/main");
    const localRange = rangeSubjects(fixture.root, "main");
    return {
      fixture,
      facts: { localRange, remoteBaseRemoved: true },
    };
  });
}

function prepareCase018(): void {
  capture("018", () => {
    const fixture = createFixture();
    git(fixture.root, "checkout", "--quiet", "-b", "feature/guard-fixture");
    commit(fixture.root, "invalid-range.txt", "invalid\n", "bad derived range subject");
    commit(fixture.root, "valid-range.txt", "valid\n", "feat: another valid commit");
    const file = join(fixture.root, "explicit-subjects.txt");
    writeFileSync(file, "chore: explicit override\n", "utf8");
    return {
      fixture,
      args: { commitFile: file },
      facts: {
        rangeSubjects: rangeSubjects(fixture.root),
        fileContents: readFileSync(file, "utf8"),
        fileExists: true,
      },
    };
  });
}

heavyBeforeAll(["git", 180_000], () => {
  prepareCases006To009();
  prepareCase010();
  prepareCases015And016();
  prepareCase017();
  prepareCase018();
});

heavyAfterAll("teardown", () => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe("consumer github guard commit range contract (CICONS-006..010, 015..018)", () => {
  it("fixture preconditions: all candidate histories and explicit inputs are discriminating", () => {
    expect(captureFor("006").error).toBeUndefined();
    expect(captureFor("006").facts).toEqual({ badSubjectInRange: true, mergeSubjectInRange: true });
    expect(captureFor("007").facts).toEqual({ mergePrefixed: true, titleIsNonConventional: true });
    expect(captureFor("008-valid").facts).toEqual({
      validFeatureInRange: true,
      validSideInRange: true,
      mergeSubjectInRange: true,
    });
    expect(captureFor("008-invalid-control").facts).toEqual({
      invalidSubjectInRange: true,
      mergeSubjectInRange: true,
    });
    expect(captureFor("009").facts).toEqual({ refMissing: true });
    expect(captureFor("010").facts).toEqual({
      fileContents: "bad commit message\n",
      fileExists: true,
    });
    expect(captureFor("015").facts).toEqual({
      rangeLength: 26,
      oldestSubject: "bad oldest subject",
    });
    expect(captureFor("016-valid").facts).toEqual({
      invalidCommitOnBase: true,
      mergeBaseUnchanged: true,
      rangeSubjects: ["feat: valid feature commit"],
    });
    expect(captureFor("016-invalid-control").facts).toEqual({
      rangeSubjects: ["bad in-range subject", "feat: valid follow-up"],
    });
    expect(captureFor("017-origin").facts).toEqual({
      localRange: ["bad remote base subject", "feat: valid feature commit"],
      remoteRange: ["feat: valid feature commit"],
      remoteBaseExists: true,
    });
    expect(captureFor("017-local-control").facts).toEqual({
      localRange: ["bad remote base subject", "feat: valid feature commit"],
      remoteBaseRemoved: true,
    });
    expect(captureFor("018").facts).toEqual({
      rangeSubjects: ["bad derived range subject", "feat: another valid commit"],
      fileContents: "chore: explicit override\n",
      fileExists: true,
    });
    preconditionsVerified = true;
  });

  it("CLI spawns: every guard execution exits normally and emits valid JSON", () => {
    for (const key of [
      "006",
      "007",
      "008-valid",
      "008-invalid-control",
      "009",
      "010",
      "015",
      "016-valid",
      "016-invalid-control",
      "017-origin",
      "017-local-control",
      "018",
    ]) {
      const current = captureFor(key);
      expect(current.error, `${key}: setup`).toBeUndefined();
      const stderr = current.child?.stderr ?? "";
      const stdout = current.child?.stdout ?? "";
      expect(
        current.child?.error,
        `${key}: spawn error; status=${current.child?.status}; stderr:\n${stderr}`,
      ).toBeUndefined();
      expect(typeof current.child?.status, `${key}: exit status; stderr:\n${stderr}`).toBe(
        "number",
      );
      let parsed: GuardResult | undefined;
      let parseError: unknown;
      try {
        parsed = JSON.parse(stdout) as GuardResult;
      } catch (error) {
        parseError = error;
      }
      expect(
        parseError,
        `${key}: invalid JSON; status=${current.child?.status}; stderr:\n${stderr}\nstdout:\n${stdout}`,
      ).toBeUndefined();
      expect(typeof parsed?.ok, `${key}: ok field; stderr:\n${stderr}`).toBe("boolean");
      expect(Array.isArray(parsed?.findings), `${key}: findings field; stderr:\n${stderr}`).toBe(
        true,
      );
    }
    spawnsVerified = true;
  });

  it("U-CICONS-006: derives subjects from base..HEAD despite a synthetic merge commit", () => {
    if (!ready("006")) return;
    const outcome = result("006");
    expect(outcome.status).toBe(1);
    expect(outcome.body.findings).toContainEqual(
      expect.objectContaining({ code: "commitlint-invalid", evidence: "bad commit message" }),
    );
  });

  it("U-CICONS-007: validates a Merge-prefixed PR title instead of skipping it", () => {
    if (!ready("007")) return;
    const outcome = result("007");
    expect(outcome.status).toBe(1);
    expect(outcome.body.findings).toContainEqual(
      expect.objectContaining({
        code: "commitlint-invalid",
        evidence: "Merge pull request from feature/guard-fixture",
      }),
    );
  });

  it("U-CICONS-008: skips Merge subjects but still evaluates valid and invalid range controls", () => {
    if (!ready("008-valid") || !ready("008-invalid-control")) return;
    expect(result("008-valid").status).toBe(0);
    expect(result("008-valid").body.ok).toBe(true);
    expect(result("008-invalid-control").status).toBe(1);
    expect(result("008-invalid-control").body.findings).toContainEqual(
      expect.objectContaining({
        code: "commitlint-invalid",
        evidence: "bad control commit message",
      }),
    );
  });

  it("U-CICONS-009: fails closed when the requested base ref does not exist", () => {
    if (!ready("009")) return;
    const outcome = result("009");
    expect(outcome.status).not.toBe(0);
    expect(outcome.body.ok).toBe(false);
  });

  it("U-CICONS-010: keeps --commit-file as an explicit compatibility input", () => {
    expect(captureFor("010").facts).toEqual({
      fileContents: "bad commit message\n",
      fileExists: true,
    });
    const outcome = result("010");
    expect(outcome.status).toBe(1);
    expect(outcome.body.findings).toContainEqual(
      expect.objectContaining({ code: "commitlint-invalid", evidence: "bad commit message" }),
    );
  });

  it("U-CICONS-015: checks the whole range when the oldest of 26 commits is invalid", () => {
    if (!ready("015")) return;
    const outcome = result("015");
    expect(outcome.status).toBe(1);
    expect(outcome.body.findings).toContainEqual(
      expect.objectContaining({ code: "commitlint-invalid", evidence: "bad oldest subject" }),
    );
  });

  it("U-CICONS-016: excludes pre-merge-base commits but rejects in-range invalid commits", () => {
    if (!ready("016-valid") || !ready("016-invalid-control")) return;
    expect(result("016-valid").status).toBe(0);
    expect(result("016-valid").body.ok).toBe(true);
    expect(result("016-invalid-control").status).toBe(1);
    expect(result("016-invalid-control").body.findings).toContainEqual(
      expect.objectContaining({ code: "commitlint-invalid", evidence: "bad in-range subject" }),
    );
  });

  it("U-CICONS-017: prefers origin/base over stale local base, with fallback control", () => {
    if (!ready("017-origin") || !ready("017-local-control")) return;
    expect(result("017-origin").status).toBe(0);
    expect(result("017-origin").body.ok).toBe(true);
    expect(result("017-local-control").status).toBe(1);
    expect(result("017-local-control").body.findings).toContainEqual(
      expect.objectContaining({ code: "commitlint-invalid", evidence: "bad remote base subject" }),
    );
  });

  it("U-CICONS-018: explicit --commit-file overrides an invalid derived range", () => {
    expect(captureFor("018").facts).toEqual({
      rangeSubjects: ["bad derived range subject", "feat: another valid commit"],
      fileContents: "chore: explicit override\n",
      fileExists: true,
    });
    const outcome = result("018");
    expect(outcome.status).toBe(0);
    expect(outcome.body.ok).toBe(true);
    expect(outcome.body.findings).toEqual([]);
  });
});
