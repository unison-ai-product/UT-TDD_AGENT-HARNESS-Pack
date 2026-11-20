import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzePrivacyScan,
  findEmailHitLines,
  type PrivacyUnit,
} from "../src/lint/privacy-scan.ts";
import {
  checkPrivacyScan,
  loadDiffPrivacyUnits,
  loadPreviousPrivacyBaseline,
  loadTreePrivacyUnits,
  readPrivacyDenylistFile,
} from "../src/lint/privacy-scan-inputs.ts";
import { heavyAfterAll } from "./support/hook-bounds.ts";
import { removeTestTree } from "./support/temp-tree.ts";

// L7 §2: no source line may match the email shape, so addresses are joined at runtime.
const at = "@";
const mail = (local: string, domain: string) => [local, domain].join(at);
const P = mail("alice", "mail-provider.jp");
// L7 §2: tests/ ship in the Pack, so the synthetic denylist word is joined at runtime too.
const D = ["example", "private", "repo"].join("-");
const BASELINE_PATH = "docs/governance/privacy-scan-baseline.json";
const DENYLIST = [".ut-tdd", "privacy-denylist.txt"];

let authorRoot = "";
let scratchRoot = "";

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true }).trim();
}

function initRepo(label: string): string {
  const root = join(scratchRoot, label);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", mail("test", "example.invalid")]);
  git(root, ["config", "user.name", "Privacy Scan Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.autocrlf", "false"]);
  return root;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

function commit(root: string, message: string, env: NodeJS.ProcessEnv = process.env): string {
  git(root, ["add", "-A"], env);
  git(root, ["commit", "-q", "--allow-empty", "-m", message], env);
  return git(root, ["rev-parse", "HEAD"]);
}

function makeHome(label: string, denylist: string | null): string {
  const home = join(scratchRoot, label);
  mkdirSync(join(home, DENYLIST[0]), { recursive: true });
  if (denylist !== null) writeFileSync(join(home, ...DENYLIST), denylist, "utf8");
  return home;
}

function runCli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [join(authorRoot, "src", "cli.ts"), "privacy-scan", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

function stateMtimes(root: string): Map<string, number> {
  const state = new Map<string, number>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      state.set(absolutePath, statSync(absolutePath).mtimeMs);
      if (entry.isDirectory()) visit(absolutePath);
    }
  };
  visit(join(root, ".ut-tdd"));
  return state;
}

const lineTexts = (unit: PrivacyUnit | undefined) => (unit?.lines ?? []).map((line) => line.text);

beforeAll(() => {
  authorRoot = process.cwd();
  scratchRoot = mkdtempSync(join(tmpdir(), "privacy-scan-integration-"));
});

heavyAfterAll("teardown", () => {
  if (scratchRoot) removeTestTree(scratchRoot);
});

describe("privacy scan candidate oracles (adapters and live repository)", () => {
  it("U-PRIVSCAN-013: loaders read commits, not the work tree, and fail closed", () => {
    const tree = initRepo("tree");
    write(tree, "docs/x.md", `head\n${P}\n`);
    commit(tree, "add x");
    rmSync(join(tree, "docs/x.md"));
    write(tree, "docs/y.md", `${P}\n`);
    const loaded = loadTreePrivacyUnits(tree, "HEAD");
    expect(loaded.kind).toBe("found");
    if (loaded.kind !== "found") return;
    const content = loaded.units.find((u) => u.path === "docs/x.md" && u.field === "content");
    expect(lineTexts(content)).toContain(P);
    expect(loaded.units.some((u) => u.path === "docs/y.md")).toBe(false);

    const range = initRepo("range");
    write(range, "docs/a.md", "base\n");
    const base = commit(range, "base");
    git(range, ["checkout", "-q", "-b", "side"]);
    write(range, "docs/side.md", "side change\n");
    commit(range, "side");
    git(range, ["checkout", "-q", "main"]);
    write(range, "docs/a.md", `base\n${P}\n`);
    const a = commit(range, "add line");
    write(range, "docs/a.md", "base\n");
    const b = commit(range, "remove line");
    git(range, ["merge", "-q", "--no-ff", "--no-edit", "side"], {
      ...process.env,
      GIT_AUTHOR_EMAIL: P,
    });
    const m = git(range, ["rev-parse", "HEAD"]);
    const diff = loadDiffPrivacyUnits(range, { base, head: m });
    expect(diff.kind).toBe("found");
    if (diff.kind !== "found") return;
    const added = diff.units.find(
      (u) => u.commit === a && u.path === "docs/a.md" && u.field === "content",
    );
    expect(added?.lines).toEqual([{ line: 2, text: P }]);
    expect(diff.units.some((u) => u.commit === m && u.path === "docs/side.md")).toBe(true);
    const author = diff.units.find((u) => u.commit === m && u.field === "author");
    expect(lineTexts(author)).toEqual([P]);
    for (const id of [a, b, m]) {
      expect(diff.units.some((u) => u.commit === id && u.field === "message")).toBe(true);
    }

    const prior = initRepo("prior");
    write(prior, "docs/z.md", "z\n");
    commit(prior, "no baseline");
    git(prior, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    expect(loadPreviousPrivacyBaseline(prior)).toEqual({ kind: "absent" });
    write(prior, BASELINE_PATH, '["docs/z.md"]\n');
    commit(prior, "baseline");
    git(prior, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    expect(loadPreviousPrivacyBaseline(prior)).toEqual({
      kind: "found",
      baseline: ["docs/z.md"],
    });
    write(prior, BASELINE_PATH, '["docs/z.md"');
    commit(prior, "broken baseline");
    git(prior, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    expect(loadPreviousPrivacyBaseline(prior)).toEqual({ kind: "unreadable" });
    git(prior, ["update-ref", "-d", "refs/remotes/origin/main"]);
    expect(loadPreviousPrivacyBaseline(prior)).toEqual({ kind: "unreadable" });

    const missing = join(scratchRoot, "no-such-directory");
    expect(loadTreePrivacyUnits(missing, "HEAD")).toEqual({ kind: "unreadable" });
    expect(loadDiffPrivacyUnits(missing, { base: "a", head: "b" })).toEqual({ kind: "unreadable" });
    expect(loadPreviousPrivacyBaseline(missing)).toEqual({ kind: "unreadable" });

    expect(
      readPrivacyDenylistFile({ homeDirectory: makeHome("h-none", null), repoRoot: tree }),
    ).toEqual({
      kind: "absent",
    });
    const providedState = readPrivacyDenylistFile({
      homeDirectory: makeHome("h-one", `${D}\n`),
      repoRoot: tree,
    });
    expect(providedState.kind).toBe("provided");
    expect(providedState.kind === "provided" ? providedState.entries.length : 0).toBe(1);
    const dirHome = makeHome("h-dir", null);
    mkdirSync(join(dirHome, ...DENYLIST));
    expect(readPrivacyDenylistFile({ homeDirectory: dirHome, repoRoot: tree })).toEqual({
      kind: "unreadable",
    });
    const inRepoHome = join(tree, "home");
    mkdirSync(join(inRepoHome, DENYLIST[0]), { recursive: true });
    writeFileSync(join(inRepoHome, ...DENYLIST), `${D}\n`, "utf8");
    expect(readPrivacyDenylistFile({ homeDirectory: inRepoHome, repoRoot: tree })).toEqual({
      kind: "in-repo",
    });
  });

  it("U-PRIVSCAN-015: accepts the live repository and rejects new hits via the CLI", () => {
    const live = checkPrivacyScan({ repoRoot: authorRoot, mode: "tree", rev: "HEAD" });
    expect(live.ok).toBe(true);
    expect(live.messages.at(-1)).toContain("denylist=unused");
    const tracked = new Set(git(authorRoot, ["ls-files"]).split(/\r?\n/));
    const baseline = JSON.parse(readFileSync(join(authorRoot, BASELINE_PATH), "utf8")) as string[];
    for (const path of baseline) {
      expect(tracked.has(path), path).toBe(true);
      const texts = readFileSync(join(authorRoot, path), "utf8").replace(/\r\n/g, "\n").split("\n");
      const unit: PrivacyUnit = {
        source: "tree",
        path,
        commit: null,
        field: "content",
        lines: texts.map((text, index) => ({ line: index + 1, text })),
      };
      expect(findEmailHitLines(unit).length, path).toBeGreaterThan(0);
    }

    const copy = join(scratchRoot, "live-copy");
    git(scratchRoot, ["clone", "-q", "--no-hardlinks", authorRoot, copy]);
    git(copy, ["config", "user.email", mail("test", "example.invalid")]);
    git(copy, ["config", "user.name", "Privacy Scan Test"]);
    git(copy, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    write(copy, ".ut-tdd/harness.db", "temporary read-only CLI fixture\n");
    const before = stateMtimes(copy);
    const readme = join(copy, "docs", "governance", "README.md");
    writeFileSync(readme, `${readFileSync(readme, "utf8")}\n${P}\n`, "utf8");
    git(copy, ["add", "docs/governance/README.md"]);
    git(copy, ["commit", "-q", "-m", "add hit"]);
    const strict = runCli(copy, ["check", "--mode", "tree", "--fail-close"]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("docs/governance/README.md:");
    expect(strict.stdout).toContain(":privacy-email-hit");
    expect(runCli(copy, ["check", "--mode", "tree"]).status).toBe(0);
    git(copy, ["revert", "--no-edit", "HEAD"]);
    const baselinePath = join(copy, BASELINE_PATH);
    const grownBaseline = [...baseline, "docs/governance/README.md"].sort();
    writeFileSync(baselinePath, `${JSON.stringify(grownBaseline, null, 2)}\n`, "utf8");
    git(copy, ["add", BASELINE_PATH]);
    git(copy, ["commit", "-q", "-m", "grow baseline"]);
    const grown = runCli(copy, ["check", "--mode", "tree", "--fail-close"]);
    expect(grown.stdout).toContain("privacy-baseline-grown");
    expect(stateMtimes(copy)).toEqual(before);
  }, 300_000);

  it("U-PRIVSCAN-016: wires the scan into the required Linux CI job", () => {
    const workflows = join(authorRoot, ".github", "workflows");
    const harness = readFileSync(join(workflows, "harness-check.yml"), "utf8");
    const job = harness.slice(
      harness.indexOf("  harness-check-linux:"),
      harness.indexOf("\n  harness-check-windows:"),
    );
    const start = job.indexOf("privacy-scan check");
    expect(start).toBeGreaterThan(-1);
    const stepStart = job.lastIndexOf("\n      - ", start);
    const stepEnd = job.indexOf("\n      - ", start);
    const step = job.slice(stepStart, stepEnd === -1 ? undefined : stepEnd);
    expect(step).not.toMatch(/^\s+if:/m);
    expect(step).toContain("--mode tree");
    expect(step).toContain("--mode diff");
    expect(step).toContain("github.event.pull_request.base.sha");
    expect(step).toContain("github.event.pull_request.head.sha");
    expect(step.match(/--fail-close/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(step).not.toContain("secrets.");
    for (const name of readdirSync(workflows)) {
      const text = readFileSync(join(workflows, name), "utf8");
      expect(text, name).not.toContain("PRIVACY_DENYLIST");
      expect(text, name).not.toContain("privacy-denylist");
    }
    expect(readFileSync(join(workflows, "security.yml"), "utf8")).not.toContain("privacy-scan");
  });

  it("U-PRIVSCAN-017: reads lines added while resolving a merge conflict", () => {
    const build = (label: string, resolutionLine: string) => {
      const root = initRepo(label);
      write(root, "docs/x.md", "one\ntwo\nthree\nfour\nfive\n");
      commit(root, "base");
      git(root, ["checkout", "-q", "-b", "work"]);
      write(root, "docs/x.md", "one\nwork-change\nthree\nfour\nfive\n");
      commit(root, "work change");
      git(root, ["checkout", "-q", "main"]);
      write(root, "docs/x.md", "one\nmain-change\nthree\nfour\nfive\n");
      commit(root, "main change");
      git(root, ["checkout", "-q", "work"]);
      spawnSync("git", ["merge", "-q", "main"], { cwd: root, windowsHide: true });
      write(root, "docs/x.md", `one\nresolved\nthree\n${resolutionLine}\nfive\n`);
      const merge = commit(root, "merge main into work");
      write(root, "docs/x.md", "one\nresolved\nthree\nfour\nfive\n");
      const head = commit(root, "remove line");
      return { root, merge, head };
    };
    const leaked = build("conflict-leak", P);
    const units = loadDiffPrivacyUnits(leaked.root, { base: "main", head: leaked.head });
    expect(units.kind).toBe("found");
    if (units.kind !== "found") return;
    const result = analyzePrivacyScan({
      mode: "diff",
      units: units.units,
      skipped: 0,
      denylist: null,
      baseline: null,
      baselineUnreadable: false,
      previousBaseline: null,
    });
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        location: `docs/x.md@${leaked.merge.slice(0, 12)}`,
        line: 4,
        kind: "privacy-email-hit",
      }),
    );
    const headTree = loadTreePrivacyUnits(leaked.root, leaked.head);
    expect(headTree.kind).toBe("found");
    if (headTree.kind !== "found") return;
    expect(
      headTree.units.flatMap((unit) => (unit.path === "docs/x.md" ? findEmailHitLines(unit) : [])),
    ).toEqual([]);
    const control = build("conflict-control", "four");
    const controlUnits = loadDiffPrivacyUnits(control.root, { base: "main", head: control.head });
    expect(controlUnits.kind).toBe("found");
    if (controlUnits.kind !== "found") return;
    expect(
      analyzePrivacyScan({
        mode: "diff",
        units: controlUnits.units,
        skipped: 0,
        denylist: null,
        baseline: null,
        baselineUnreadable: false,
        previousBaseline: null,
      }).findings,
    ).toEqual([]);
  });

  // #1454 r1 FINDING 2 (L6 §2): a rename without a content change has no `+++` header.
  it("U-PRIVSCAN-013 (regression): reads the path of a rename without a content change", () => {
    const root = initRepo("rename-only");
    write(root, "docs/safe.md", "plain\n");
    const base = commit(root, "safe");
    git(root, ["mv", "docs/safe.md", `docs/${P}.md`]);
    commit(root, "rename to a leaking name");
    git(root, ["mv", `docs/${P}.md`, "docs/safe.md"]);
    const head = commit(root, "rename back");
    const loaded = loadDiffPrivacyUnits(root, { base, head });
    expect(loaded.kind).toBe("found");
    const units = loaded.kind === "found" ? loaded.units : [];
    expect(units.some((unit) => unit.field === "path" && unit.path === `docs/${P}.md`)).toBe(true);
    const result = analyzePrivacyScan({
      mode: "diff",
      units,
      skipped: 0,
      denylist: null,
      baseline: null,
      baselineUnreadable: false,
      previousBaseline: null,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.kind)).toContain("privacy-email-hit");
  });

  // #1454 r1 FINDING 3 (L6 §4): a junction (Windows) or symlink must not hide an in-repo denylist.
  it("U-PRIVSCAN-013 (regression): judges the denylist placement by real paths", () => {
    const tree = initRepo("link-tree");
    const target = join(tree, "linked-state");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, DENYLIST[1]), `${D}\n`, "utf8");
    const home = join(scratchRoot, "link-home");
    mkdirSync(home, { recursive: true });
    symlinkSync(target, join(home, DENYLIST[0]), process.platform === "win32" ? "junction" : "dir");
    expect(readFileSync(join(home, ...DENYLIST), "utf8")).toBe(`${D}\n`);
    expect(readPrivacyDenylistFile({ homeDirectory: home, repoRoot: tree })).toEqual({
      kind: "in-repo",
    });
  });
});
