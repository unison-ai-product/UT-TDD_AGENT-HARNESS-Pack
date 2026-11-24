import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
  parsePublicationManifest,
} from "../src/schema/release-manifest.ts";
import { buildCleanDistributionPlan } from "../src/setup/distribution.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";

const MANIFEST = "release/manifest.yaml";
const TAG = "v0.0.0-canary.8";
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "C2 contract fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "C2 contract fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf8",
    env: GIT_ENV,
    windowsHide: true,
  }).trimEnd();
}

function write(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
}

function previousRecord(seed: string) {
  return {
    materializerVersion: "1" as const,
    artifactSourceCommit: seed.repeat(40),
    artifactSetDigest: `sha256:${seed.repeat(64)}`,
  };
}

function previousManifest(version: "v1" | "v2") {
  const releases = ["a", "b"].map((seed) => {
    const base = previousRecord(seed);
    const id = deriveReleaseId("1", base.artifactSourceCommit, base.artifactSetDigest);
    const artifacts = [
      {
        sourcePath: "README.md",
        destinationPath: "README.md",
        mode: "100644" as const,
        size: 1,
        contentDigest: `sha256:${digest(Buffer.from(seed))}`,
      },
    ];
    const record = {
      ...base,
      artifactInventoryDigest: deriveArtifactInventoryDigest(artifacts),
      releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
      artifacts,
    };
    return [
      id,
      version === "v1"
        ? base
        : { ...record, releaseRecordDigest: deriveReleaseRecordDigest(record) },
    ] as const;
  });
  return {
    schema_version: version,
    releases: Object.fromEntries(releases),
    channels: { canary: releases[0][0], stable: releases[1][0] },
    channelOrder: ["canary", "stable"],
  };
}

function commitPrevious(root: string, branch: string, text: string): string {
  git(root, "checkout", "-q", "-b", branch);
  write(root, MANIFEST, text);
  git(root, "add", "--", MANIFEST);
  git(root, "commit", "-q", "-m", branch);
  const result = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  return result;
}

function worktreeHashes(root: string, prefix = ""): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (item.name === ".git") continue;
    const path = join(root, item.name);
    const name = `${prefix}${item.name}`;
    if (item.isDirectory()) Object.assign(contents, worktreeHashes(path, `${name}/`));
    else if (item.isSymbolicLink()) contents[name] = `link:${readlinkSync(path)}`;
    else contents[name] = digest(readFileSync(path));
  }
  return contents;
}

function snapshot(root: string) {
  return {
    head: readFileSync(join(root, ".git", "HEAD"), "utf8"),
    refs: git(root, "for-each-ref", "--format=%(refname) %(objectname)"),
    index: git(root, "ls-files", "--stage", "-z"),
    releaseDir: existsSync(join(root, "release")),
    tree: worktreeHashes(root),
  };
}

function run(cwd: string, args: string[], gitTrace?: string, environment?: NodeJS.ProcessEnv) {
  const executionRoot = process.env.UT_TDD_TEST_EXECUTION_ROOT;
  if (!executionRoot) throw Error("The test execution snapshot is required");
  const cli = join(executionRoot, "src", "cli.ts");
  const result = spawnSync(process.execPath, [cli, "distribution", ...args], {
    cwd,
    env: {
      ...process.env,
      ...environment,
      UT_TDD_SKIP_UPDATE_CHECK: "1",
      ...(gitTrace && { GIT_TRACE2_EVENT: gitTrace }),
    },
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status === null || result.signal !== null)
    throw Error("distribution did not exit normally");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitCommands(trace: string): string[][] {
  if (!existsSync(trace)) return [];
  return readFileSync(trace, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
    .flatMap((row) => (row.event === "start" && row.argv ? [row.argv] : []));
}

function jsonOutput(stdout: Buffer): unknown {
  try {
    return JSON.parse(stdout.toString("utf8"));
  } catch {
    return null;
  }
}

interface Scenario {
  key: string;
  tag?: string;
  rootOption?: boolean;
  text?: boolean;
  previous?: string;
  head?: string;
  environment?: NodeJS.ProcessEnv;
  prepare?: (root: string) => void;
}

describe("Pack C2 manifest command candidate oracles", () => {
  let scratch: string;
  let seed: string;
  let c1: string;
  let previous: string;
  let invalid: string;
  let v1: string;
  let artifactCount: number;
  let observations: Map<string, ReturnType<typeof observe>>;

  function observe(scenario: Scenario) {
    const root = join(scratch, scenario.key);
    git(scratch, "clone", "-q", "--no-tags", "-c", "core.autocrlf=false", seed, root);
    scenario.prepare?.(root);
    const before = snapshot(root);
    const tag = scenario.tag ?? TAG;
    const args = [
      "c2-manifest",
      "--c1",
      scenario.head ?? c1,
      "--tag",
      tag,
      "--previous",
      scenario.previous ?? previous,
    ];
    if (!scenario.text) args.push("--json");
    if (scenario.rootOption) {
      const packRoot =
        process.platform === "win32"
          ? git(root, "rev-parse", "--show-toplevel").replace(/^[a-z](?=:)/i, (drive) =>
              drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase(),
            )
          : root;
      args.push("--pack-root", packRoot);
    }
    const trace = join(scratch, `${scenario.key}-git.jsonl`);
    const recordGit = scenario.key === "success" || scenario.key === "tag-exists";
    const result = run(
      scenario.rootOption ? scratch : root,
      args,
      recordGit ? trace : undefined,
      scenario.environment,
    );
    const output = join(root, MANIFEST);
    return {
      before,
      after: snapshot(root),
      ...result,
      manifest: existsSync(output) ? readFileSync(output) : null,
      commands: gitCommands(trace),
    };
  }

  function read(key: string) {
    const value = observations.get(key);
    if (!value) throw Error(`Observation missing: ${key}`);
    return value;
  }

  heavyBeforeAll(["db", 300_000], () => {
    scratch = mkdtempSync(join(tmpdir(), "ut-tdd-c2-cli-"));
    seed = join(scratch, "seed");
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    const paths = buildCleanDistributionPlan({ paths: [] }).missingRequired;
    artifactCount = paths.length;
    for (const path of paths) {
      write(
        seed,
        path,
        path === "package.json"
          ? '{"name":"c2-fixture","version":"0.0.0","type":"module"}\n'
          : `fixture ${path}\n`,
      );
    }
    git(seed, "add", "--", ...paths);
    git(seed, "commit", "-q", "-m", "C1 fixture");
    c1 = git(seed, "rev-parse", "HEAD");
    expect(c1).toMatch(/^[a-f0-9]{40}$/);
    const current = previousManifest("v2");
    const legacy = previousManifest("v1");
    expect(parsePublicationManifest(current).ok).toBe(true);
    expect(parsePublicationManifest(legacy)).toEqual({ ok: false, error: "v1_read_only" });
    previous = commitPrevious(seed, "previous", JSON.stringify(current));
    invalid = commitPrevious(seed, "invalid", "[:\n");
    v1 = commitPrevious(seed, "v1", JSON.stringify(legacy));
    expect(git(seed, "status", "--porcelain")).toBe("");
    expect(run(seed, ["--help"]).status).toBe(0);
    const controlTrace = join(scratch, "git-control.jsonl");
    const traceControl = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: seed,
      env: { ...GIT_ENV, GIT_TRACE2_EVENT: controlTrace },
      windowsHide: true,
    });
    expect(traceControl.status).toBe(0);
    expect(gitCommands(controlTrace)).toContainEqual(expect.arrayContaining(["rev-parse", "HEAD"]));

    const scenarios: Scenario[] = [
      { key: "success", environment: { TZ: "UTC" } },
      { key: "wrong-head", head: previous },
      { key: "dirty-tracked", prepare: (root) => write(root, "README.md", "modified\n") },
      { key: "dirty-untracked", prepare: (root) => write(root, "extra.txt", "untracked\n") },
      {
        key: "tracked-manifest",
        head: previous,
        prepare: (root) => {
          git(root, "checkout", "-q", "--detach", previous);
        },
      },
      { key: "previous-unavailable", previous: "0".repeat(40) },
      { key: "previous-invalid", previous: invalid },
      { key: "previous-v1", previous: v1 },
      { key: "stable-tag", tag: "v0.0.0" },
      { key: "invalid-tag", tag: "v0.0.0-canary.8..fixture" },
      { key: "tag-with-space", tag: "v0.0.0-canary.8 fixture" },
      {
        key: "tag-exists",
        rootOption: true,
        environment: { TZ: "Pacific/Kiritimati" },
        prepare: (root) => {
          git(root, "tag", TAG, previous);
        },
      },
      { key: "target-exists", prepare: (root) => write(root, MANIFEST, "untracked manifest\n") },
      { key: "text-success", text: true },
      { key: "text-failure", text: true, tag: "v0.0.0" },
    ];
    observations = new Map(scenarios.map((scenario) => [scenario.key, observe(scenario)]));
    expect(observations.size).toBe(scenarios.length);
    expect(read("success").before.tree[MANIFEST]).toBeUndefined();
    expect(read("tag-exists").before.refs).toContain(`refs/tags/${TAG} ${previous}`);
    expect(read("previous-v1").before.refs).toContain(v1);
  });

  heavyAfterAll("teardown", () => {
    if (scratch) removeTestTree(scratch);
  });

  it("U-C2MAN-001: CLI output is independent of cwd and environment", () => {
    const inside = read("success");
    const outside = read("tag-exists");
    expect(inside.status).toBe(0);
    expect(outside.status).toBe(0);
    expect(inside.manifest).not.toBeNull();
    expect(outside.manifest).toEqual(inside.manifest);
  });

  it("U-C2MAN-007: success adds only the manifest with no index or ref changes", () => {
    const result = read("success");
    expect(result.status).toBe(0);
    expect(result.manifest).not.toBeNull();
    if (!result.manifest) throw Error("No manifest bytes were written");
    expect(result.after).toEqual({
      ...result.before,
      releaseDir: true,
      tree: { ...result.before.tree, [MANIFEST]: digest(result.manifest) },
    });
  });

  function expectUnchangedFailure(scenario: string, reason: string) {
    const result = read(scenario);
    expect(result.status).toBe(1);
    expect(jsonOutput(result.stdout)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(new RegExp(`^${reason}(?:$|:)`)),
    });
    expect(result.after).toEqual(result.before);
  }

  it("U-C2MAN-008: rejects a C1 that is not the current HEAD", () => {
    expectUnchangedFailure("wrong-head", "c2_c1_not_head");
  });

  it.each(["dirty-tracked", "dirty-untracked"])("U-C2MAN-009: rejects %s", (scenario) => {
    expectUnchangedFailure(scenario, "c2_worktree_dirty");
  });

  it("U-C2MAN-010: rejects a manifest tracked in C1", () => {
    expectUnchangedFailure("tracked-manifest", "c2_manifest_present_in_c1");
  });

  it.each([
    ["previous-unavailable", "c2_previous_unavailable"],
    ["previous-invalid", "c2_previous_invalid"],
    ["previous-v1", "c2_previous_invalid"],
  ])("U-C2MAN-011: rejects %s", (scenario, reason) => {
    expectUnchangedFailure(scenario, reason);
    if (scenario === "previous-v1")
      expect(read(scenario).stdout.toString()).toContain("v1_read_only");
  });

  it.each([
    ["stable-tag", "c2_tag_not_canary"],
    ["invalid-tag", "c2_option_invalid"],
    ["tag-with-space", "c2_option_invalid"],
  ])("U-C2MAN-012: rejects %s", (scenario, reason) => {
    expectUnchangedFailure(scenario, reason);
  });

  it("U-C2MAN-013: tag presence or an explicit Pack root does not change the bytes", () => {
    const absent = read("success");
    const present = read("tag-exists");
    expect(absent.before.refs).not.toContain(`refs/tags/${TAG}`);
    expect(absent.status).toBe(0);
    expect(present.status).toBe(0);
    expect(absent.manifest).not.toBeNull();
    expect(present.manifest).toEqual(absent.manifest);
    expect(present.after.refs).toBe(present.before.refs);
    expect(absent.after.refs).toBe(absent.before.refs);
    for (const { commands } of [absent, present]) {
      expect(commands.length).toBeGreaterThan(0);
      expect(
        commands
          .flat()
          .some((arg) => arg === "tag" || arg.includes("refs/tags/") || arg.includes(TAG)),
      ).toBe(false);
    }
  });

  it("U-C2MAN-019: preserves an untracked manifest", () => {
    const result = read("target-exists");
    expect(result.status).toBe(1);
    const output = jsonOutput(result.stdout);
    expect(output).toEqual(
      expect.objectContaining({
        ok: false,
        reason: expect.stringMatching(/^c2_(worktree_dirty|target_exists)(?:$|:)/),
      }),
    );
    expect(result.manifest?.toString("utf8")).toBe("untracked manifest\n");
    expect(result.after).toEqual(result.before);
  });

  it("U-C2MAN-020: wires success and failure output for JSON and text callers", () => {
    const success = read("success");
    const failure = read("stable-tag");
    const textSuccess = read("text-success");
    const textFailure = read("text-failure");
    expect(success.status).toBe(0);
    expect(failure.status).toBe(1);
    expect(textSuccess.status).toBe(0);
    expect(textFailure.status).toBe(1);
    expect(success.manifest).not.toBeNull();
    expect(textSuccess.manifest).toEqual(success.manifest);
    expect(textFailure.after).toEqual(textFailure.before);
    expect(Buffer.concat([textFailure.stdout, textFailure.stderr]).toString("utf8")).toContain(
      "c2_tag_not_canary",
    );
    if (!success.manifest) throw Error("No manifest bytes were written");
    const manifest = parsePublicationManifest(parse(success.manifest.toString("utf8")));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) throw Error("Fixture manifest did not validate");
    const output = jsonOutput(success.stdout) as { manifestSha256?: unknown };
    expect(output).toMatchObject({
      ok: true,
      c1,
      tag: TAG,
      releaseId: manifest.value.channels.canary,
      channel: "canary",
      artifactCount,
      manifestPath: expect.stringMatching(/(?:^|[\\/])release[\\/]manifest\.yaml$/),
    });
    expect(String(output.manifestSha256).replace(/^sha256:/, "")).toBe(digest(success.manifest));
    expect(jsonOutput(failure.stdout)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^c2_tag_not_canary(?:$|:)/),
    });
    for (const bytes of [
      success.stdout,
      failure.stdout,
      textSuccess.stdout,
      textFailure.stdout,
      textFailure.stderr,
      success.manifest,
    ]) {
      expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(bytes.toString("utf8")).not.toContain("\r");
      expect(bytes.toString("utf8")).not.toContain("\ufffd");
    }
  });
});
