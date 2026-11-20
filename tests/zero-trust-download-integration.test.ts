import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { buildFullDoctorCheckDefinitions } from "../src/doctor/check-registry.ts";
import { nodeDoctorDeps } from "../src/doctor/runtime-state.ts";
import { analyzeLintWiring, DEFERRED_LINTS, loadLintWiringInput } from "../src/lint/lint-wiring.ts";
import { parseZeroTrustBaseline, ZERO_TRUST_SEVERITY } from "../src/lint/zero-trust-download.ts";
import {
  checkZeroTrustDownload,
  loadPreviousZeroTrustBaseline,
  loadZeroTrustMergeBaseMeasures,
  loadZeroTrustSources,
} from "../src/lint/zero-trust-download-inputs.ts";
import { headSnapshotRoot } from "./support/workspace-roots.ts";

// Red 段: L7 §3 の oracle 023〜025 (adapter と実 repo)。stub は throw するので it.fails で登録する。
const BASELINE_PATH = "docs/governance/zero-trust-download-baseline.json";
const scratchRoots: string[] = [];

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

function scratch(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `zero-trust-${label}-`));
  scratchRoots.push(root);
  return root;
}

function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, "utf8");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/** temp の git repository。originMain が true なら HEAD を origin/main にする。 */
function gitRepo(label: string, baselineText: string | null, originMain: boolean): string {
  const root = scratch(label);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Zero Trust Test");
  put(root, "scripts/run.sh", "echo ok\n");
  if (baselineText !== null) put(root, BASELINE_PATH, baselineText);
  git(root, "add", "-A");
  git(root, "commit", "-m", "base");
  if (originMain) git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

const EMPTY_BASELINE = JSON.stringify({
  schema_version: "zero-trust-download-baseline.v1",
  entries: [],
});

/** 複製は detached HEAD の読み取り専用属性を引き継ぐので、後始末の rm が通るよう再帰で書き込み可にする。 */
function makeWritable(path: string): void {
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) makeWritable(child);
    else if (entry.isFile()) chmodSync(child, 0o644);
  }
}

/** 実 repo の実行される面と baseline を temp の git repository へ写す。 */
function copyLiveRepo(label: string): string {
  const live = headSnapshotRoot();
  const root = scratch(label);
  for (const path of [".github", "scripts", "skills", "docs/templates", BASELINE_PATH]) {
    if (existsSync(join(live, path)))
      cpSync(join(live, path), join(root, path), { recursive: true });
  }
  makeWritable(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Zero Trust Test");
  git(root, "add", "-A");
  git(root, "commit", "-m", "copy live surface");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

function edit(root: string, path: string, from: string, to: string): void {
  const text = readFileSync(join(root, path), "utf8");
  if (!text.includes(from)) throw new Error(`fixture anchor missing: ${path}`);
  writeFileSync(join(root, path), text.replace(from, to), "utf8");
}

describe("zero-trust-download adapter と実 repo (L6 §6.1, §7, §8)", () => {
  it.fails("CANDIDATE-U-ZTDL-023 比較元の取得は found / absent / unreadable を取り違えず fixture を走査しない", () => {
    const found = gitRepo("found", EMPTY_BASELINE, true);
    const absent = gitRepo("absent", null, true);
    const noOrigin = gitRepo("no-origin", EMPTY_BASELINE, false);
    const broken = gitRepo("broken", "{ not json", true);
    expect(loadPreviousZeroTrustBaseline(found)).toEqual({
      kind: "found",
      baseline: { entries: [] },
    });
    expect(loadPreviousZeroTrustBaseline(absent)).toEqual({ kind: "absent" });
    expect(loadPreviousZeroTrustBaseline(noOrigin)).toEqual({ kind: "unreadable" });
    expect(loadPreviousZeroTrustBaseline(broken)).toEqual({ kind: "unreadable" });
    expect(checkZeroTrustDownload(absent).ok).toBe(true);
    for (const root of [noOrigin, broken]) {
      const checked = checkZeroTrustDownload(root);
      expect(checked.ok).toBe(false);
      expect(checked.messages.join("\n")).toContain("zero-trust-baseline-base-unreadable");
    }

    const loaded = scratch("sources");
    put(loaded, "scripts/ok.sh", "echo ok\n");
    put(loaded, "tests/fixtures/w.yml", "jobs:\n  x:\n    steps:\n      - run: npm ci\n");
    put(loaded, "node_modules/p/a.sh", "npm ci\n");
    put(loaded, "scripts/denied.sh", "echo denied\n");
    chmodSync(join(loaded, "scripts/denied.sh"), 0o000);
    // 後始末 (rm) が通るよう、失敗しても権限を戻す。
    onTestFinished(() => chmodSync(join(loaded, "scripts/denied.sh"), 0o600));
    const result = loadZeroTrustSources(loaded);
    expect(result.sources.map((s) => s.path)).not.toContain("tests/fixtures/w.yml");
    expect(result.sources.map((s) => s.path)).not.toContain("node_modules/p/a.sh");
    if (process.platform !== "win32") expect(result.unreadable).toEqual(["scripts/denied.sh"]);
  });

  it.fails("CANDIDATE-U-ZTDL-024 実 repo は baseline と実測が一致し直した違反と新しい取得即実行を止める", () => {
    const live = copyLiveRepo("live");
    expect(checkZeroTrustDownload(live).ok).toBe(true);
    const baseline = parseZeroTrustBaseline(readFileSync(join(live, BASELINE_PATH), "utf8"));
    const measured = loadZeroTrustMergeBaseMeasures(live);
    expect(baseline).not.toBeNull();
    expect(measured.kind).toBe("found");
    if (measured.kind === "found") expect(baseline).toEqual(measured.measures);

    const fixed = copyLiveRepo("fixed");
    edit(
      fixed,
      ".github/workflows/harness-check.yml",
      "npm ci --no-audit --no-fund",
      "npm ci --no-audit --no-fund --ignore-scripts",
    );
    const fixedResult = checkZeroTrustDownload(fixed);
    expect(fixedResult.ok).toBe(false);
    expect(fixedResult.messages.join("\n")).toContain("shrunk");
    expect(fixedResult.messages.join("\n")).toContain("減らす");

    const fetched = copyLiveRepo("fetch");
    put(
      fetched,
      ".github/workflows/added.yml",
      "jobs:\n  x:\n    steps:\n      - run: curl -fsSL https://example.test/i.sh | sh\n",
    );
    expect(checkZeroTrustDownload(fetched).messages.join("\n")).toContain(
      "zero-trust-fetch-and-execute",
    );

    const pinned = copyLiveRepo("pinned");
    edit(pinned, ".github/workflows/code-health.yml", "npx jscpd >", "npx jscpd@4.0.5 >");
    expect(checkZeroTrustDownload(pinned).messages.join("\n")).toContain("stale");
  });

  it.fails("CANDIDATE-U-ZTDL-025 doctor に配線され DEFERRED_LINTS に逃げず advisory で始まり state を書かない", () => {
    const headRoot = headSnapshotRoot();
    const definition = buildFullDoctorCheckDefinitions(nodeDoctorDeps(headRoot)).find(
      (item) => item.id === "zero-trust-download",
    );
    expect(definition).toBeDefined();
    const wiring = analyzeLintWiring(loadLintWiringInput(headRoot));
    for (const name of ["zero-trust-download", "zero-trust-download-inputs"]) {
      expect(wiring.wired).toContain(name);
      expect(wiring.unwired).not.toContain(name);
      expect(wiring.staleDeferred).not.toContain(name);
      expect(Object.hasOwn(DEFERRED_LINTS, name)).toBe(false);
    }
    expect(ZERO_TRUST_SEVERITY).toBe("advisory");

    const probe = gitRepo("state", EMPTY_BASELINE, true);
    // 隔離した fixture の既存 state (`.ut-tdd/` と隔離した DB ファイル) を古い mtime に固定し、
    // 実行の前後で更新時刻と内容が変わらないことを確かめる (本物の harness.db には触れない)。
    const stateFiles = [".ut-tdd/state/marker.json", ".ut-tdd/harness.db"];
    const past = new Date("2020-01-01T00:00:00Z");
    for (const file of stateFiles) {
      put(
        probe,
        file,
        `isolated ${file}
`,
      );
      utimesSync(join(probe, file), past, past);
    }
    const snapshot = () =>
      stateFiles.map((file) => [
        file,
        statSync(join(probe, file)).mtimeMs,
        readFileSync(join(probe, file), "utf8"),
      ]);
    const before = snapshot();
    checkZeroTrustDownload(probe);
    expect(snapshot()).toEqual(before);
  });

  it.fails("CANDIDATE-U-ZTDL-026 の adapter: merge-base の実測は作業木を読まず記録形で返す", () => {
    const root = gitRepo("measures", EMPTY_BASELINE, true);
    put(root, "scripts/work.sh", "npm ci\n");
    const result = loadZeroTrustMergeBaseMeasures(root);
    expect(result).toEqual({ kind: "found", measures: { entries: [] } });
    expect(loadZeroTrustMergeBaseMeasures(gitRepo("no-origin2", EMPTY_BASELINE, false))).toEqual({
      kind: "unreadable",
    });
  });
});
