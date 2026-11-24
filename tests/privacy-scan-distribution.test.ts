import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  deriveArtifactInventoryDigest,
  deriveReleaseId,
  deriveReleaseRecordDigest,
} from "../src/schema/release-manifest.ts";
import { buildCleanDistributionPlan } from "../src/setup/distribution.ts";
import {
  digestConsumerRuntimeBytes,
  digestMaterializedReleaseEntries,
} from "../src/setup/index.ts";
import { heavyAfterAll, heavyBeforeAll } from "./support/hook-bounds.ts";
import { copyPackBuildInputs, copyPackFiles } from "./support/pack-build-input-fixture.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// L7 §2: no source line may match the email shape, so addresses are joined at runtime.
const at = "@";
const mail = (local: string, domain: string) => [local, domain].join(at);
const P = mail("alice", "mail-provider.jp");
// L7 §2: tests/ ship in the Pack, so the synthetic denylist word is joined at runtime too.
const D = ["example", "private", "repo"].join("-");
const LEAK_LINE = `${["pass", "word"].join("")} = q7w8e9r0t1y2u3`;
const BASELINE_PATH = "docs/governance/privacy-scan-baseline.json";
const DENYLIST = [".ut-tdd", "privacy-denylist.txt"];
const TAG = "v0.0.0-test";

let authorRoot = "";
let scratchRoot = "";
let sharedSeedRoot = "";
const sharedCloneRoots: string[] = [];
let cleanArtifactMaterializations = 0;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true }).trim();
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

function makeHome(label: string, denylist: string | null): string {
  const home = join(scratchRoot, label);
  mkdirSync(join(home, DENYLIST[0]), { recursive: true });
  if (denylist !== null) writeFileSync(join(home, ...DENYLIST), denylist, "utf8");
  return home;
}

function walkFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(directory, entry.name);
      if (entry.isDirectory()) visit(abs, rel);
      else out.set(rel, readFileSync(abs, "latin1"));
    }
  };
  visit(root, "");
  return out;
}

function changedFiles(
  before: Map<string, string>,
  after: Map<string, string>,
): Map<string, string> {
  return new Map([...after].filter(([path, text]) => before.get(path) !== text));
}

/** A v2 release manifest whose only release points at `artifactSourceCommit` (both channels). */
function releaseManifest(artifactSourceCommit: string): Record<string, unknown> {
  const content = Buffer.from("export const fixture = true;\n", "utf8");
  const artifacts = [
    {
      sourcePath: "src/artifact.ts",
      destinationPath: "src/artifact.ts",
      mode: "100644" as const,
      size: content.length,
      contentDigest: digestConsumerRuntimeBytes(content),
    },
  ];
  const artifactSetDigest = digestMaterializedReleaseEntries([
    { path: "src/artifact.ts", mode: "100644", content },
  ]);
  const base = {
    materializerVersion: "1",
    artifactSourceCommit,
    artifactSetDigest,
    artifactInventoryDigest: deriveArtifactInventoryDigest(artifacts),
    releaseAssetInventoryDigest: `sha256:${"c".repeat(64)}`,
    artifacts,
  };
  const releaseId = deriveReleaseId("1", artifactSourceCommit, artifactSetDigest);
  return {
    schema_version: "v2",
    releases: { [releaseId]: { ...base, releaseRecordDigest: deriveReleaseRecordDigest(base) } },
    channels: { canary: releaseId, stable: releaseId },
    channelOrder: ["canary", "stable"],
  };
}

/** Materializes and commits the clean Pack artifacts, with optional case inputs. */
function commitCleanArtifacts(root: string, prepare?: () => void): void {
  const sourcePaths = git(authorRoot, ["ls-files"]).split(/\r?\n/).filter(Boolean);
  const plan = buildCleanDistributionPlan({ paths: sourcePaths, sourceTag: TAG });
  copyPackFiles(authorRoot, root, plan.artifactPaths, sourcePaths, true);
  copyPackBuildInputs(authorRoot, root, sourcePaths);
  cleanArtifactMaterializations++;
  prepare?.();
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "core.autocrlf", "false"]);
  configureFixtureIdentity(root);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "clean artifacts"]);
}

function configureFixtureIdentity(root: string): void {
  git(root, ["config", "user.email", mail("test", "example.invalid")]);
  git(root, ["config", "user.name", "Privacy Scan Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
}

function appendFixtureReadme(root: string, readmeSuffix: string): void {
  const readme = join(root, "README.md");
  writeFileSync(readme, `${readFileSync(readme, "utf8")}\n${readmeSuffix}\n`, "utf8");
}

function tagReleaseManifest(root: string): void {
  const artifactSource = git(root, ["rev-parse", "HEAD"]);
  write(root, "release/manifest.yaml", stringify(releaseManifest(artifactSource)));
  git(root, ["add", "--", "release/manifest.yaml"]);
  git(root, ["commit", "-q", "-m", "release manifest"]);
  git(root, ["tag", TAG]);
}

function cleanSourceFromSeed(label: string, seedRoot: string, readmeSuffix: string): string {
  if (!seedRoot) return cleanSource(label, readmeSuffix);
  const root = join(scratchRoot, label);
  sharedCloneRoots.push(root);
  git(scratchRoot, [
    "clone",
    "--quiet",
    "--shared",
    "--no-tags",
    "-c",
    "core.autocrlf=false",
    seedRoot,
    root,
  ]);
  configureFixtureIdentity(root);
  appendFixtureReadme(root, readmeSuffix);
  git(root, ["add", "--", "README.md"]);
  git(root, ["commit", "-q", "-m", "case artifact"]);
  tagReleaseManifest(root);
  return root;
}

function sourceGitState(root: string) {
  const [head, releaseTag] = git(root, ["rev-parse", "HEAD", `${TAG}^{commit}`]).split(/\r?\n/);
  return {
    head,
    releaseTag,
    status: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    diff: git(root, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]),
  };
}

/**
 * Copies the clean Pack artifact set of the execution snapshot into a temp git repository.
 * The artifacts are commit c1; c2 adds a release manifest bound to c1 and carries TAG, so
 * `package` scans the tag snapshot (L6 §2 / §11) and `sync-pack` scans the HEAD tree.
 */
function cleanSource(
  label: string,
  readmeSuffix: string,
  extra: Record<string, string> = {},
): string {
  const root = join(scratchRoot, label);
  commitCleanArtifacts(root, () => {
    appendFixtureReadme(root, readmeSuffix);
    for (const [path, text] of Object.entries(extra)) write(root, path, text);
  });
  tagReleaseManifest(root);
  return root;
}

function runDistribution(cwd: string, home: string, args: string[]) {
  return spawnSync(process.execPath, [join(authorRoot, "src", "cli.ts"), "distribution", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 300_000,
    windowsHide: true,
  });
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type ScanJson = { ok: boolean; findings: Record<string, unknown>[] };
const privacyJson = (stdout: string) => (parseJson(stdout)?.privacyScan ?? null) as ScanJson | null;
const kinds = (scan: ScanJson | null) => (scan?.findings ?? []).map((finding) => finding.kind);

beforeAll(() => {
  authorRoot = process.cwd();
  scratchRoot = mkdtempSync(join(tmpdir(), "privacy-scan-integration-"));
});

heavyAfterAll(["teardown", 120000], () => {
  // Borrowing clones need the seed's object store until they are removed.
  for (const root of sharedCloneRoots) removeTestTree(root);
  if (sharedSeedRoot) removeTestTree(sharedSeedRoot);
  if (scratchRoot) removeTestTree(scratchRoot);
}); // afterAll >10s on Windows (file 479s, hook unmeasured), bounded per #1063

describe("Pack privacy distribution source fixtures", () => {
  let emailSource: string;
  let plainSource: string;
  let denySource: string;
  let materializationCount: number;

  // #1259: Windows maxima after fixture reuse were 77.148s for preparation and 217.972s for the body.
  heavyBeforeAll(["pack", 180_000], () => {
    const before = cleanArtifactMaterializations;
    sharedSeedRoot = join(scratchRoot, "d-seed");
    commitCleanArtifacts(sharedSeedRoot);
    emailSource = cleanSourceFromSeed("d-email", sharedSeedRoot, P);
    plainSource = cleanSourceFromSeed("d-plain", sharedSeedRoot, "plain line");
    denySource = cleanSourceFromSeed("d-deny", sharedSeedRoot, `mentions ${D}`);
    materializationCount = cleanArtifactMaterializations - before;
  });

  it("U-PRIVSCAN-014: distribution stops before writing when the Pack scan fails", () => {
    const denyHome = makeHome("d-home", `${D}\n`);
    const packDir = join(scratchRoot, "d-pack");
    mkdirSync(packDir, { recursive: true });
    const sync = runDistribution(emailSource, denyHome, [
      "sync-pack",
      "--repo-dir",
      packDir,
      "--json",
    ]);
    expect(sync.status).toBe(1);
    expect(readdirSync(packDir)).toEqual([]);
    const scan = privacyJson(sync.stdout);
    expect(scan?.ok).toBe(false);
    expect(kinds(scan)).toContain("privacy-email-hit");
    for (const finding of scan?.findings ?? []) {
      expect(
        Object.keys(finding).every((key) => ["location", "line", "kind", "reason"].includes(key)),
      ).toBe(true);
    }
    const releaseDir = join(scratchRoot, "d-release");
    const pkg = runDistribution(emailSource, denyHome, [
      "package",
      "--tag",
      TAG,
      "--out",
      releaseDir,
      "--json",
    ]);
    expect(pkg.status).toBe(1);
    expect(existsSync(join(releaseDir, `${TAG}.tar.gz`))).toBe(false);
    expect(privacyJson(pkg.stdout)?.ok).toBe(false);

    const absentHome = makeHome("d-absent", null);
    for (const command of [
      ["sync-pack", "--repo-dir", packDir],
      ["package", "--tag", TAG, "--out", releaseDir],
    ]) {
      const absent = runDistribution(plainSource, absentHome, [...command, "--json"]);
      expect(absent.status).toBe(1);
      expect(privacyJson(absent.stdout)?.findings).toContainEqual(
        expect.objectContaining({ kind: "privacy-denylist-unavailable", reason: "absent" }),
      );
      const text = runDistribution(plainSource, absentHome, command);
      expect(`${text.stdout}${text.stderr}`).toContain("~/.ut-tdd/privacy-denylist.txt");
    }
    const empty = runDistribution(plainSource, makeHome("d-empty", ""), [
      "sync-pack",
      "--repo-dir",
      packDir,
      "--json",
    ]);
    expect(privacyJson(empty.stdout)?.findings).toContainEqual(
      expect.objectContaining({ kind: "privacy-denylist-unavailable", reason: "empty" }),
    );
    const deny = runDistribution(denySource, denyHome, [
      "sync-pack",
      "--repo-dir",
      packDir,
      "--json",
    ]);
    expect(deny.status).toBe(1);
    expect(kinds(privacyJson(deny.stdout))).toContain("privacy-denylist-hit");
    const clean = runDistribution(plainSource, denyHome, [
      "sync-pack",
      "--repo-dir",
      packDir,
      "--json",
    ]);
    expect(clean.status).toBe(0);
    expect(privacyJson(clean.stdout)?.ok).toBe(true);
    const stage = runDistribution(plainSource, absentHome, [
      "sync-stage",
      "--tag",
      TAG,
      "--out",
      join(scratchRoot, "d-stage"),
      "--json",
    ]);
    expect(stage.status).toBe(0);
    const emailTagBefore = git(emailSource, ["rev-parse", `${TAG}^{commit}`]);
    const plainStateBefore = sourceGitState(plainSource);
    const denyStateBefore = sourceGitState(denySource);
    expect(
      new Set([emailTagBefore, plainStateBefore.releaseTag, denyStateBefore.releaseTag]).size,
    ).toBe(3);
    write(emailSource, BASELINE_PATH, '["README.md"]\n');
    git(emailSource, ["add", "--", BASELINE_PATH]);
    git(emailSource, ["commit", "-q", "-m", "baseline"]);
    expect(git(emailSource, ["rev-parse", `${TAG}^{commit}`])).toBe(emailTagBefore);
    expect(sourceGitState(plainSource)).toEqual(plainStateBefore);
    expect(sourceGitState(denySource)).toEqual(denyStateBefore);
    const baselined = runDistribution(emailSource, denyHome, [
      "sync-pack",
      "--repo-dir",
      join(scratchRoot, "d-pack-baseline"),
      "--json",
    ]);
    expect(baselined.status).toBe(1);
    expect(kinds(privacyJson(baselined.stdout))).toContain("privacy-email-hit");
  }, 360_000);

  it("U-PRIVSCAN-014: materializes the common Clean Pack artifacts once", () => {
    expect(materializationCount).toBe(1);
  });
});

describe("privacy scan candidate oracles (distribution)", () => {
  describe("U-PRIVSCAN-018: never leaks denylist contents into output, evidence, or source", () => {
    // L7 018: each of the 8 runs (2 denylist states x 2 commands x json on/off) is its own
    // test with its own timeout, so one slow spawn cannot starve the rest.
    const commentMarker = "unique-comment-marker-1391";
    const invalidEntry = "unclosed-group-entry(";
    const forbidden = [D, commentMarker, "unclosed-group-entry"];
    const homes = { invalid: "", hit: "" };
    let source = "";
    let packDir = "";
    let releaseDir = "";

    heavyBeforeAll(["git", 300_000], () => {
      homes.invalid = makeHome("l-home-invalid", `# ${commentMarker}\n${D}\n${invalidEntry}\n`);
      homes.hit = makeHome("l-home-hit", `# ${commentMarker}\n${D}\n`);
      source = cleanSource("l-source", `mentions ${D}`);
      packDir = join(scratchRoot, "l-pack");
      releaseDir = join(scratchRoot, "l-release");
      mkdirSync(packDir, { recursive: true });
    });

    const cases = (["invalid", "hit"] as const).flatMap((state) =>
      [true, false].flatMap((json) =>
        (["sync-pack", "package"] as const).map((command) => ({ state, json, command })),
      ),
    );

    it.each(cases)("$state denylist, $command, json=$json", ({ state, json, command }) => {
      const args =
        command === "sync-pack"
          ? ["sync-pack", "--repo-dir", packDir]
          : ["package", "--tag", TAG, "--out", releaseDir];
      const sourceBefore = walkFiles(source);
      const result = runDistribution(source, homes[state], json ? [...args, "--json"] : args);
      expect(result.status).toBe(1);
      const outputs = [result.stdout, result.stderr];
      const written = [...walkFiles(packDir).values(), ...walkFiles(releaseDir).values()];
      const sourceChanged = changedFiles(sourceBefore, walkFiles(source));
      for (const value of forbidden.slice(1)) {
        for (const text of [...outputs, ...written, ...sourceChanged.values()]) {
          expect(text).not.toContain(value);
        }
      }
      for (const text of [...outputs, ...written, ...sourceChanged.values()]) {
        expect(text).not.toContain(D);
      }
      expect(readFileSync(join(source, "README.md"), "utf8")).toContain(`mentions ${D}`);
      for (const path of [...walkFiles(source).keys(), ...walkFiles(packDir).keys()]) {
        expect(path.endsWith("privacy-denylist.txt"), path).toBe(false);
      }
      expect(outputs.join("\n")).toContain(
        state === "invalid" ? "privacy-denylist-invalid" : "privacy-denylist-hit",
      );
    }, 400_000);
  });

  // #1454 r1 FINDING 1 (L6 §8 / §12): a hit artifact path must not leak through the export plan,
  // the next commands, or the sync-pack evidence. #1454 r2: also when a command shell-escapes it.
  it.each([
    { label: "plain", hitPath: `skills/${D}-note.md` },
    { label: "shell-escaped", hitPath: `skills/$${D}-note.md` },
  ])("U-PRIVSCAN-018 (regression): masks a hit artifact path in sync-pack output and evidence ($label)", ({
    label,
    hitPath,
  }) => {
    const home = makeHome(`r-home-${label}`, `${D}\n`);
    const source = cleanSourceFromSeed(`r-source-${label}`, sharedSeedRoot, "plain line");
    write(source, hitPath, "plain\n");
    git(source, ["add", "--", hitPath]);
    git(source, ["commit", "-q", "-m", "hit path"]);
    const plan = buildCleanDistributionPlan({
      paths: git(source, ["ls-files"]).split(/\r?\n/).filter(Boolean),
      sourceTag: TAG,
    });
    expect(plan.artifactPaths).toContain(hitPath);
    const packDir = join(scratchRoot, `r-pack-${label}`);
    mkdirSync(packDir, { recursive: true });
    const evidenceBefore = walkFiles(join(source, ".ut-tdd"));
    const result = runDistribution(source, home, ["sync-pack", "--repo-dir", packDir, "--json"]);
    expect(result.status).toBe(1);
    expect(kinds(privacyJson(result.stdout))).toContain("privacy-denylist-hit");
    expect(result.stdout).toContain("path-sha256:");
    const evidence = [...changedFiles(evidenceBefore, walkFiles(join(source, ".ut-tdd"))).values()];
    expect(evidence.length).toBeGreaterThan(0);
    for (const text of [result.stdout, result.stderr, ...evidence]) {
      expect(text).not.toContain(D);
    }
  }, 180_000);

  // #1454 r3 (L6 §8 / §12): both scans always run, and once the privacy scan rejects, the secret
  // scan's path is masked as well. The file below is hit by both scans at once.
  it.each([
    { label: "package-json", args: ["package", "--tag", TAG, "--json"] },
    { label: "package-text", args: ["package", "--tag", TAG] },
    { label: "sync-pack-json", args: ["sync-pack", "--json"] },
    { label: "sync-pack-text", args: ["sync-pack"] },
  ])("U-PRIVSCAN-018 (regression): reports both scans and no secret-scan path ($label)", ({
    label,
    args,
  }) => {
    const home = makeHome(`b-home-${label}`, `${D}\n`);
    const hitPath = `skills/${D}-note.md`;
    const source = cleanSource(`b-source-${label}`, "plain line", {
      [hitPath]: `${LEAK_LINE}\n`,
    });
    const outDir = join(scratchRoot, `b-out-${label}`);
    mkdirSync(outDir, { recursive: true });
    const target = args[0] === "package" ? "--out" : "--repo-dir";
    const evidenceBefore = walkFiles(join(source, ".ut-tdd"));
    const result = runDistribution(source, home, [...args, target, outDir]);
    expect(result.status).toBe(1);
    expect(readdirSync(outDir)).toEqual([]);
    expect(result.stdout).toContain("path-sha256:");
    if (args.includes("--json")) {
      expect(kinds(privacyJson(result.stdout))).toContain("privacy-denylist-hit");
      expect(result.stdout).toContain("secret-assignment");
    } else {
      expect(result.stdout).toContain("secret-scan — violation");
      expect(result.stdout).toContain("privacy-denylist-hit");
    }
    const evidence = [...changedFiles(evidenceBefore, walkFiles(join(source, ".ut-tdd"))).values()];
    for (const text of [result.stdout, result.stderr, ...evidence]) {
      expect(text).not.toContain(D);
    }
  }, 400_000);

  // #1454 r2 (L6 §8 / §12): an unreadable artifact drops every finding, so no hit path can be
  // derived. A rejected sync-pack must still report no artifact path at all.
  it("U-PRIVSCAN-018 (regression): reports no artifact path when an artifact is unreadable", () => {
    const home = makeHome("u-home", `${D}\n`);
    const source = cleanSource("u-source", "plain line");
    const hitPath = `skills/${D}-note.md`;
    const missingPath = "skills/zz-missing-note.md";
    write(source, hitPath, "plain\n");
    write(source, missingPath, "plain\n");
    git(source, ["add", "--", hitPath, missingPath]);
    git(source, ["commit", "-q", "-m", "hit path and missing path"]);
    rmSync(join(source, missingPath));
    const plan = buildCleanDistributionPlan({
      paths: git(source, ["ls-files"]).split(/\r?\n/).filter(Boolean),
      sourceTag: TAG,
    });
    expect(plan.artifactPaths).toEqual(expect.arrayContaining([hitPath, missingPath]));
    const packDir = join(scratchRoot, "u-pack");
    mkdirSync(packDir, { recursive: true });
    const evidenceBefore = walkFiles(join(source, ".ut-tdd"));
    const result = runDistribution(source, home, ["sync-pack", "--repo-dir", packDir, "--json"]);
    expect(result.status).toBe(1);
    expect(kinds(privacyJson(result.stdout))).toContain("privacy-input-unreadable");
    expect((parseJson(result.stdout)?.pack as { copiedArtifacts?: number })?.copiedArtifacts).toBe(
      0,
    );
    expect(readdirSync(packDir)).toEqual([]);
    const evidence = [...changedFiles(evidenceBefore, walkFiles(join(source, ".ut-tdd"))).values()];
    expect(evidence.length).toBeGreaterThan(0);
    for (const text of [result.stdout, result.stderr, ...evidence]) {
      expect(text).not.toContain(D);
      expect(text).not.toContain(missingPath);
    }
  }, 400_000);
});
