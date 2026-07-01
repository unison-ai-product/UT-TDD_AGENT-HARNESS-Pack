import { describe, expect, it } from "vitest";
import {
  analyzeReadability,
  loadFreezeReadabilityDocs,
  loadL6ReadabilityDocs,
  loadRuntimeArtifactReadabilityDocs,
  loadSystemReadabilityDocs,
  readabilityMessages,
  runtimeReadabilityMessages,
} from "../src/lint/readability";

describe("readability lint (freeze doc mojibake guard)", () => {
  it("detects replacement characters and em-space/ascii mojibake", () => {
    const result = analyzeReadability([
      { path: "a.md", text: "# title\n§3.1 実�画\n" },
      { path: "b.md", text: "# gate-confirm lint \u2001Efunction design\n" },
      { path: "c.md", text: "逕ｨ隱樊峩譁ｰ\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      { path: "a.md", marker: "replacement-character", line: 2 },
      { path: "b.md", marker: "em-space-before-ascii", line: 1 },
      { path: "c.md", marker: "halfwidth-katakana", line: 1 },
      { path: "c.md", marker: "cp932-mojibake", line: 1 },
    ]);
  });

  it("flags halfwidth katakana — the 工程表→蟾･遞玖｡ｨ class the curated kanji list missed", () => {
    const result = analyzeReadability([{ path: "d.md", text: "## 3. 蟾･遞玖｡ｨ\n" }]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.marker)).toContain("halfwidth-katakana");
  });

  it("system readability band spans the whole docs tree and the active tree is mojibake-free", () => {
    const docs = loadSystemReadabilityDocs();
    const paths = docs.map((doc) => doc.path.replaceAll("\\", "/"));
    expect(docs.length).toBeGreaterThan(50);
    expect(paths).toContain("docs/plans/PLAN-M-00-verify-cutover.md");
    expect(paths).toContain("docs/governance/README.md");
    expect(paths).toContain("CLAUDE.md");
    expect(analyzeReadability(docs).violations).toEqual([]);
  });

  it("formats a clear doctor message", () => {
    const messages = readabilityMessages(
      analyzeReadability([{ path: "a.md", text: "l6-fr-coverage 窶・weak" }]),
    );
    expect(messages[0]).toContain("readability — ⚠ mojibake markers 1件");
    expect(messages[0]).toContain("a.md:1:cp932-mojibake");
  });

  it("real L6 design docs are readable", () => {
    const result = analyzeReadability(loadL6ReadabilityDocs());
    expect(result.violations).toEqual([]);
  });

  it("freeze review docs include the PM-trace L5 plans and remain readable", () => {
    const docs = loadFreezeReadabilityDocs();
    const paths = docs.map((doc) => doc.path.replaceAll("\\", "/"));
    expect(paths).toContain("docs/plans/PLAN-L5-03-internal-processing.md");
    expect(paths).toContain("docs/plans/PLAN-L5-05-roster.md");
    expect(paths).toContain("docs/plans/PLAN-L5-06-skill.md");
    expect(paths).toContain("docs/plans/PLAN-L5-07-drift.md");
    expect(analyzeReadability(docs).violations).toEqual([]);
  });
});

describe("runtime-artifact readability guard (PLAN-L7-69: .ut-tdd audit/handover)", () => {
  it("loader spans .ut-tdd/audit markdown + .ut-tdd/handover JSON and the real artifacts are mojibake-free", () => {
    const docs = loadRuntimeArtifactReadabilityDocs();
    const paths = docs.map((doc) => doc.path.replaceAll("\\", "/"));
    // Assert on TRACKED runtime evidence only: the A-NNN audit markdown ledger and
    // the cross-agent provider JSON payloads are committed, so they are present in a
    // fresh CI checkout. CURRENT.json is the handover pointer but is gitignored
    // (.ut-tdd/handover/CURRENT.*) — it exists locally but NOT in CI, so asserting
    // its presence here was a local-green/CI-red trap. Its handling is covered by the
    // fixture tests below (clean + replacement-character cases). The loader's
    // fail-open-on-absence design means an absent CURRENT.json is correct, not a gap.
    expect(paths.some((p) => p.startsWith(".ut-tdd/audit/") && p.endsWith(".md"))).toBe(true);
    expect(
      paths.some((p) => p.startsWith(".ut-tdd/handover/provider/") && p.endsWith(".json")),
    ).toBe(true);
    // loader scope: every loaded path stays within the two runtime-evidence roots.
    expect(
      paths.every((p) => p.startsWith(".ut-tdd/audit/") || p.startsWith(".ut-tdd/handover/")),
    ).toBe(true);
    expect(analyzeReadability(docs).violations).toEqual([]);
  });

  it("fails on unreadable handover/audit markdown (negative fixture)", () => {
    const result = analyzeReadability([
      { path: ".ut-tdd/audit/A-999-corrupt.md", text: "# audit\n逕ｨ隱樊峩譁ｰ corrupt line\n" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.marker)).toContain("cp932-mojibake");
  });

  it("fails on provider JSON whose string field contains a mojibake marker (negative fixture)", () => {
    const corruptProviderJson = JSON.stringify({
      from: "codex",
      to: "claude",
      summary: "蟾･遞玖｡ｨ was corrupted by CP932 round-trip",
    });
    const result = analyzeReadability([
      { path: ".ut-tdd/handover/provider/corrupt.json", text: corruptProviderJson },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.marker)).toContain("halfwidth-katakana");
  });

  it("fails on a U+FFFD replacement character in provider JSON (negative fixture)", () => {
    const result = analyzeReadability([
      { path: ".ut-tdd/handover/provider/repl.json", text: '{"summary":"plan �"}' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.marker)).toContain("replacement-character");
  });

  it("passes clean ASCII handover JSON and fullwidth-only Japanese audit text", () => {
    const result = analyzeReadability([
      { path: ".ut-tdd/handover/CURRENT.json", text: '{"active_plan":"PLAN-L7-69","status":"ok"}' },
      { path: ".ut-tdd/audit/A-100-clean.md", text: "# 監査\n工程表は直列で実行する。\n" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("formats a distinct doctor message labeled runtime-readability", () => {
    const ok = runtimeReadabilityMessages(analyzeReadability([]));
    expect(ok[0]).toContain("runtime-readability — OK");
    const bad = runtimeReadabilityMessages(
      analyzeReadability([{ path: ".ut-tdd/handover/provider/x.json", text: '{"s":"窶"}' }]),
    );
    expect(bad[0]).toContain("runtime-readability — ⚠ mojibake markers 1件");
    expect(bad[0]).toContain(".ut-tdd/handover/provider/x.json:1:cp932-mojibake");
  });
});
