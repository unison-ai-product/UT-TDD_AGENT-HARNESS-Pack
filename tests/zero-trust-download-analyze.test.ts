import { describe, expect, it } from "vitest";
import {
  analyzeZeroTrustDownload,
  parseZeroTrustBaseline,
  type ScanSource,
  type ZeroTrustInput,
} from "../src/lint/zero-trust-download.ts";
import { baseline, sh, source } from "./fixtures/zero-trust-download-fixtures.ts";

// Red 段: L7 §3 の oracle 017〜022 と 026 (純粋関数の判定)。stub は throw / null なので it.fails。
const WF = ".github/workflows/harness-check.yml";
const INSTALL = "zero-trust-install-scripts-missing";
const FETCH = "zero-trust-fetch-and-execute";
const NPM_CI = "npm ci --no-audit --no-fund";
type Row = [path: string, rule: string, subject: string, count: number];

function wf(n: number): ScanSource {
  const steps = Array(n).fill(`      - run: ${NPM_CI}`).join("\n");
  return source(WF, `jobs:\n  x:\n    steps:\n${steps}\n`);
}

function input(patch: Partial<ZeroTrustInput>): ZeroTrustInput {
  return {
    sources: [wf(4)],
    baseline: baseline([WF, INSTALL, NPM_CI, 4]),
    previousBaseline: baseline([WF, INSTALL, NPM_CI, 4]),
    mergeBaseMeasures: null,
    severity: "fail-close",
    ...patch,
  };
}

const run = (patch: Partial<ZeroTrustInput>) => analyzeZeroTrustDownload(input(patch));
const rulesOf = (patch: Partial<ZeroTrustInput>): string[] =>
  run(patch).findings.map((f) => f.rule);
const reasonsOf = (patch: Partial<ZeroTrustInput>): string[] =>
  run(patch).findings.map((f) => f.reason);

describe("zero-trust-download analyze と baseline (L6 §6)", () => {
  it.fails("CANDIDATE-U-ZTDL-017 baseline の count を超えた分だけを violation にする", () => {
    const ok = run({});
    expect(ok.findings).toEqual([]);
    expect(ok.ok).toBe(true);
    expect(ok.summary).toMatch(/checked=\d+ violations=0 stale=0 baseline=1/);
    const over = run({ baseline: baseline([WF, INSTALL, NPM_CI, 3]), previousBaseline: null });
    expect(over.ok).toBe(false);
    expect(over.findings.filter((f) => f.rule === "zero-trust-violation")).toHaveLength(1);
  });

  it.fails("CANDIDATE-U-ZTDL-018 baseline に無い (path, rule, subject) は violation で行番号は同一性に含めない", () => {
    const empty = { baseline: baseline(), previousBaseline: baseline() };
    expect(run({ ...empty, sources: [wf(1)] }).ok).toBe(false);
    expect(run({ ...empty, sources: [sh("curl u | sh")] }).ok).toBe(false);
    const entry = baseline(["scripts/a.sh", INSTALL, "npm ci", 1]);
    const other = (s: ScanSource) =>
      run({ sources: [s], baseline: entry, previousBaseline: entry });
    expect(other(source("scripts/a.sh", "npm ci --foo")).ok).toBe(false);
    expect(other(source("scripts/b.sh", "npm ci")).ok).toBe(false);
    expect(other(source("scripts/a.sh", "echo 1\necho 2\nnpm ci")).ok).toBe(true);
  });

  it.fails("CANDIDATE-U-ZTDL-019 実測が baseline 未満・0・対象外 path なら stale で advisory でも止める", () => {
    const advisory = { severity: "advisory" as const };
    const none = source(WF, "jobs:\n  x:\n    steps:\n      - run: echo\n");
    expect(reasonsOf({ ...advisory, sources: [none] })).toContain("fixed");
    expect(run({ ...advisory, sources: [none] }).ok).toBe(false);
    expect(reasonsOf({ ...advisory, sources: [wf(2)] })).toContain("shrunk");
    expect(reasonsOf({ ...advisory, sources: [sh("echo ok")] })).toContain("missing-file");
    expect(run(advisory).findings).toEqual([]);
  });

  it.fails("CANDIDATE-U-ZTDL-020 比較元より増えた・足した baseline は grown で縮小と null 初回の一致は通す", () => {
    const cur = (count: number, ...extra: Row[]) =>
      baseline([WF, INSTALL, NPM_CI, count], ...extra);
    const prev = cur(4);
    expect(rulesOf({ baseline: cur(4), previousBaseline: prev })).toEqual([]);
    expect(rulesOf({ baseline: cur(5), previousBaseline: prev })).toContain(
      "zero-trust-baseline-grown",
    );
    const added = run({
      baseline: cur(4, ["scripts/new.sh", INSTALL, "npm ci", 1]),
      previousBaseline: prev,
    });
    expect(added.findings.map((f) => f.rule)).toContain("zero-trust-baseline-grown");
    expect(added.ok).toBe(false);
    expect(run({ sources: [wf(3)], baseline: cur(3), previousBaseline: prev }).ok).toBe(true);
    expect(run({ previousBaseline: null, mergeBaseMeasures: cur(4) }).ok).toBe(true);
  });

  it.fails("CANDIDATE-U-ZTDL-021 advisory は violation を出すが ok を落とさず出力は入力順に依存しない", () => {
    const fresh = {
      sources: [sh("curl u | sh")],
      baseline: baseline(),
      previousBaseline: baseline(),
    };
    const adv = run({ ...fresh, severity: "advisory" });
    expect(adv.findings.map((f) => f.rule)).toContain("zero-trust-violation");
    expect(adv.ok).toBe(true);
    expect(run({ ...fresh, severity: "fail-close" }).ok).toBe(false);

    const a = sh("curl u | sh");
    const b = source("scripts/b.sh", "npm ci");
    const e1 = baseline(["x.sh", INSTALL, "a", 1], ["y.sh", INSTALL, "b", 1]);
    const e2 = baseline(["y.sh", INSTALL, "b", 1], ["x.sh", INSTALL, "a", 1]);
    const common = { previousBaseline: null, severity: "advisory" as const };
    const r1 = run({ ...common, sources: [a, b], baseline: e1, mergeBaseMeasures: e1 });
    const r2 = run({ ...common, sources: [b, a], baseline: e2, mergeBaseMeasures: e2 });
    expect(r2.findings).toEqual(r1.findings);
    expect(r2.summary).toBe(r1.summary);

    const empty = run({ sources: [] });
    expect(empty.findings.map((f) => f.rule)).toContain("zero-trust-input-unreadable");
    expect(empty.ok).toBe(false);
  });

  it.fails("CANDIDATE-U-ZTDL-022 parseZeroTrustBaseline は壊れた入力を null にして空を空として読む", () => {
    const v = "zero-trust-download-baseline.v1";
    const entry = { path: WF, rule: INSTALL, subject: NPM_CI, count: 4 };
    const text = (entries: unknown[], version = v) =>
      JSON.stringify({ schema_version: version, entries });
    expect(parseZeroTrustBaseline(text([entry]))).toEqual({ entries: [entry] });
    expect(parseZeroTrustBaseline(text([]))).toEqual({ entries: [] });
    expect(parseZeroTrustBaseline(text([{ ...entry, count: -1 }]))).toBeNull();
    expect(parseZeroTrustBaseline(text([{ ...entry, count: 1.5 }]))).toBeNull();
    expect(parseZeroTrustBaseline(text([], "x.v0"))).toBeNull();
    expect(parseZeroTrustBaseline('{"schema_version":"zero-trust-down')).toBeNull();
    const unordered = [
      { ...entry, path: "z.yml" },
      { ...entry, path: "a.yml" },
    ];
    expect(parseZeroTrustBaseline(text(unordered))).toEqual({ entries: unordered });
  });

  it.fails("CANDIDATE-U-ZTDL-026 初回の baseline は merge-base の実測と照合し新規・増加・読めない比較元を止める", () => {
    const measures = baseline([WF, INSTALL, NPM_CI, 4]);
    const first = (patch: Partial<ZeroTrustInput>) =>
      input({ previousBaseline: null, mergeBaseMeasures: measures, ...patch });
    const go = (patch: Partial<ZeroTrustInput>) => analyzeZeroTrustDownload(first(patch));
    const newEntry: Row = ["scripts/new.sh", FETCH, "curl u", 1];
    for (const severity of ["fail-close", "advisory"] as const) {
      const r = go({
        severity,
        sources: [wf(4), source("scripts/new.sh", "curl u | sh")],
        baseline: baseline([WF, INSTALL, NPM_CI, 4], newEntry),
      });
      expect(r.findings.map((f) => f.rule)).toContain("zero-trust-initial-baseline-new-entry");
      expect(r.ok).toBe(false);
    }
    const grown = go({ sources: [wf(5)], baseline: baseline([WF, INSTALL, NPM_CI, 5]) });
    expect(grown.findings.map((f) => f.rule)).toContain("zero-trust-initial-baseline-grown");
    expect(grown.ok).toBe(false);
    expect(go({}).findings).toEqual([]);
    expect(go({ sources: [wf(2)], baseline: baseline([WF, INSTALL, NPM_CI, 2]) }).ok).toBe(true);
    const unreadable = go({ mergeBaseMeasures: null });
    expect(unreadable.findings.map((f) => f.rule)).toContain("zero-trust-baseline-base-unreadable");
    expect(unreadable.ok).toBe(false);
    const empty = go({
      sources: [sh("echo ok")],
      mergeBaseMeasures: baseline(),
      baseline: baseline(),
    });
    expect(empty.ok).toBe(true);
  });
});
