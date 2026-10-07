import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { catalogAutomationAssets } from "../src/assets/catalog.ts";
import { buildAdapterPlan } from "../src/runtime/adapter.ts";
import { buildNodeGeneration } from "../src/runtime/node-bootstrap.ts";
import {
  type EmbeddedSkillAsset,
  materializeSkillAssets,
  resolveSkillFiles,
} from "../src/shared/embedded-skills.ts";
import { buildSkillInjectionSet, recommendSkillsForText } from "../src/skill-engine/recommend.ts";
import { openHarnessDb } from "../src/state-db/index.ts";
import { migrate } from "../src/state-db/migration.ts";
import { rebuildHarnessDb } from "../src/state-db/projection-writer.ts";

const skill = (path: string, name = path.replace(/\.(md|ya?ml)$/i, "")): EmbeddedSkillAsset => ({
  path,
  content: [
    "---",
    `name: ${name}`,
    "skill_type: testing",
    "category: project",
    "applies_to:",
    "  drive_models: [Forward]",
    "description: test bundle skill for implementation and testing",
    "---",
    `# ${name}`,
    "",
  ].join("\n"),
});

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "ut-tdd-release-consumer-skills-"));
}

function materialize(root: string, assets: readonly EmbeddedSkillAsset[]): void {
  materializeSkillAssets(root, assets);
  mkdirSync(join(root, ".git"), { recursive: true });
}

function rmTestDist(path: string): void {
  const restoreWritable = (target: string): void => {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      chmodSync(target, 0o755);
      for (const entry of readdirSync(target)) restoreWritable(join(target, entry));
    } else {
      chmodSync(target, 0o644);
    }
  };
  restoreWritable(path);
  rmSync(path, { recursive: true, force: true });
}

function trackedSkillDigests(repoRoot: string): Array<{ path: string; sha256: string }> {
  const paths = execFileSync("git", ["-C", repoRoot, "ls-files", "skills"], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter((path) => /\.(md|ya?ml)$/i.test(path) && !path.endsWith(".gitkeep"));
  return paths.map((path) => ({
    path: path.replace(/^skills\//, ""),
    sha256: createHash("sha256")
      .update(readFileSync(join(repoRoot, path)))
      .digest("hex"),
  }));
}

function expectBundledSkillDigests(
  root: string,
  assets: readonly { path: string; sha256: string }[],
): void {
  for (const asset of assets) {
    const materialized = join(root, ".ut-tdd", "assets", "skills", asset.path);
    expect(
      createHash("sha256").update(readFileSync(materialized)).digest("hex"),
      `${asset.path} digest`,
    ).toBe(asset.sha256);
  }
}

function runBundledCli(
  generation: NonNullable<Awaited<ReturnType<typeof buildNodeGeneration>>>,
  root: string,
  args: string[],
): string {
  return execFileSync(generation.nodePath, [generation.compiledCliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: "{}\n",
    timeout: 60_000,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      APPDATA: root,
      GH_CONFIG_DIR: join(root, ".gh-config"),
      CLAUDE_PROJECT_DIR: "",
      UT_TDD_PROJECT_DIR: "",
      UT_TDD_CLAUDE_SESSIONS_DIR: join(root, ".claude", "projects"),
      UT_TDD_CODEX_SESSIONS_DIR: join(root, ".codex", "sessions"),
    },
  });
}

describe("PR-2a release consumer skills", () => {
  let buildRoot: string | undefined;
  let generation: Awaited<ReturnType<typeof buildNodeGeneration>> | undefined;
  afterAll(() => {
    if (buildRoot) rmTestDist(buildRoot);
  });

  it("CANDIDATE-U-RCDEV-006: bundle receipt seals every tracked skill input", async () => {
    const repoRoot = process.cwd();
    const candidateRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    buildRoot = mkdtempSync(join(tmpdir(), "ut-tdd-release-consumer-build-"));
    generation = await buildNodeGeneration({
      repoRoot,
      outputRoot: buildRoot,
      candidateRevision,
    });
    const trackedSkills = execFileSync("git", ["-C", repoRoot, "ls-files", "skills"], {
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter((path) => /\.(md|ya?ml)$/i.test(path) && !path.endsWith(".gitkeep"));
    const receipt = new Map(
      generation.receipt.source_files.map((file) => [file.path, file.sha256]),
    );
    const receiptSkillPaths = [...receipt.keys()]
      .filter((path) => path.startsWith("skills/") && /\.(md|ya?ml)$/i.test(path))
      .sort();
    expect(trackedSkills.length).toBeGreaterThan(0);
    expect(receiptSkillPaths).toEqual([...trackedSkills].sort());
    for (const path of trackedSkills) {
      expect(receipt.get(path)).toBe(
        createHash("sha256")
          .update(readFileSync(join(repoRoot, path)))
          .digest("hex"),
      );
    }
  });

  it("U-835-001 / CANDIDATE-U-RCDEV-007: bundled setup/session materialization is digest checked and ignored", () => {
    const root = fixtureRoot();
    try {
      if (!generation) throw new Error("release-consumer bundle was not built");
      const repoRoot = process.cwd();
      const assets = trackedSkillDigests(repoRoot);
      expect(assets.length).toBeGreaterThan(0);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Release Consumer Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "release-consumer@example.invalid"], {
        cwd: root,
      });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widget.git"], {
        cwd: root,
      });

      runBundledCli(generation, root, ["setup", "--solo"]);
      expectBundledSkillDigests(root, assets);
      execFileSync("git", ["check-ignore", ".ut-tdd/assets/skills/SKILL_MAP.md"], {
        cwd: root,
        encoding: "utf8",
      });
      const suggestions = JSON.parse(
        runBundledCli(generation, root, [
          "skill",
          "suggest",
          "--text",
          "TDD implementation Red-first test strategy and fixtures",
          "--json",
        ]),
      ) as unknown[];
      expect(suggestions.length).toBeGreaterThan(0);

      execFileSync("git", ["add", "-f", "--", "ut-tdd.project.json"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "setup fixture identity"], {
        cwd: root,
        env: { ...process.env, HUSKY: "0" },
      });

      const skillMap = join(root, ".ut-tdd", "assets", "skills", "SKILL_MAP.md");
      rmSync(skillMap);
      runBundledCli(generation, root, ["session", "start", "--session", "release-consumer-test"]);
      expectBundledSkillDigests(root, assets);

      // U-835-001: use this already-built canonical consumer generation to prove
      // the filesystem fault reaches bundled materialization on the real CLI route.
      const sessionId = "issue835-bundled-materialize-fault";
      rmSync(skillMap);
      mkdirSync(skillMap);
      let materializeFailure: unknown;
      try {
        runBundledCli(generation, root, ["session", "start", "--session", sessionId]);
      } catch (error) {
        materializeFailure = error;
      }
      expect(materializeFailure).toBeInstanceOf(Error);
      const stderr = String((materializeFailure as { stderr?: unknown }).stderr ?? "");
      expect(stderr).toMatch(/EISDIR|EPERM|illegal operation on a directory/i);
      const eventFile = join(root, ".ut-tdd", "logs", "session", `${sessionId}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);
      const eventTypes = readFileSync(eventFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { session_id: string; event_type: string });
      expect(eventTypes).toContainEqual(
        expect.objectContaining({ session_id: sessionId, event_type: "session_start" }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CANDIDATE-U-RCDEV-008: injection paths are resolved filesystem paths", () => {
    const root = fixtureRoot();
    const assets = [skill("testing.md")];
    try {
      materialize(root, assets);
      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        catalogAutomationAssets({ repoRoot: root, db });
        const injection = buildSkillInjectionSet(
          db,
          recommendSkillsForText(db, "test bundle implementation"),
        );
        expect([...injection.required_paths, ...injection.optional_paths]).not.toHaveLength(0);
        for (const path of [...injection.required_paths, ...injection.optional_paths])
          expect(existsSync(path) || existsSync(join(root, path))).toBe(true);
        const plan = buildAdapterPlan(
          {
            provider: "codex",
            role: "worker",
            task: "test bundle implementation",
            contextInjection: injection,
          },
          "hybrid",
        );
        // U-ADAPTER-SANDBOX-004: this existing frontier consumer must keep its pre-grant argv.
        expect(plan.args).not.toContain("--sandbox");
        expect(plan.args).not.toContain("workspace-write");
        for (const path of [...injection.required_paths, ...injection.optional_paths])
          expect(plan.stdin).toContain(path);
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CANDIDATE-U-RCDEV-009: consumer skills override same names and merge additions", () => {
    const root = fixtureRoot();
    const assets = [skill("same.md", "same"), skill("embedded-only.md", "embedded-only")];
    try {
      materialize(root, assets);
      mkdirSync(join(root, "skills"), { recursive: true });
      const consumerSame = skill("same.md", "same");
      writeFileSync(
        join(root, "skills", "same.md"),
        consumerSame.content.replace("test bundle skill", "consumer override skill"),
      );
      writeFileSync(
        join(root, "skills", "consumer-only.md"),
        skill("consumer-only.md", "consumer-only").content,
      );

      const resolved = resolveSkillFiles(root, assets);
      expect(resolved.find((entry) => entry.path === "same.md")?.source).toBe("consumer");
      expect(resolved.map((entry) => entry.path)).toEqual([
        "consumer-only.md",
        "embedded-only.md",
        "same.md",
      ]);

      const db = openHarnessDb(":memory:");
      try {
        migrate(db);
        catalogAutomationAssets({ repoRoot: root, db });
        expect(
          db.prepare("SELECT path FROM automation_assets WHERE asset_id = ?").get("skill:same"),
        ).toMatchObject({ path: "skills/same.md" });
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM automation_assets WHERE asset_type = ?")
            .get("skill"),
        ).toMatchObject({ count: 3 });
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CANDIDATE-U-RCDEV-010: bundled db rebuild restores bytes without rewriting matches", () => {
    if (!generation) throw new Error("release-consumer bundle was not built");
    const root = fixtureRoot();
    const assets = trackedSkillDigests(process.cwd());
    const targetAsset = assets.find((asset) => asset.path === "SKILL_MAP.md");
    if (!targetAsset) throw new Error("tracked bundle is missing SKILL_MAP.md");
    const target = join(root, ".ut-tdd", "assets", "skills", targetAsset.path);
    try {
      runBundledCli(generation, root, ["db", "rebuild"]);
      writeFileSync(target, "tampered\n");
      runBundledCli(generation, root, ["db", "rebuild"]);
      expectBundledSkillDigests(root, assets);
      const before = statSync(target).mtimeMs;
      runBundledCli(generation, root, ["db", "rebuild"]);
      expect(statSync(target).mtimeMs).toBe(before);

      rmSync(target);
      runBundledCli(generation, root, ["db", "rebuild"]);
      expectBundledSkillDigests(root, assets);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CANDIDATE-U-RCDEV-010 regression: source projection paths stay under skills/", () => {
    const db = openHarnessDb(":memory:");
    try {
      const rebuilt = rebuildHarnessDb({ repoRoot: process.cwd(), db, skipTokenTelemetry: true });
      expect(rebuilt.ok).toBe(true);
      const paths = db
        .prepare("SELECT path FROM automation_assets WHERE asset_type = ?")
        .all("skill") as Array<{ path: string }>;
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every(({ path }) => path.startsWith("skills/"))).toBe(true);
    } finally {
      db.close();
    }
  });
});
