import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeArtifacts,
  analyzeByteIntegrity,
  analyzeReadability,
  loadFreezeReadabilityDocs,
  loadL6ReadabilityDocs,
  loadRuntimeArtifactReadabilityDocs,
  loadSystemReadabilityDocs,
  type ReadabilityArtifact,
  readabilityMessages,
  runtimeReadabilityMessages,
} from "../src/lint/readability.ts";

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
    if (existsSync(join(process.cwd(), "docs", "plans"))) {
      expect(paths).toContain("docs/plans/PLAN-M-00-verify-cutover.md");
    }
    expect(paths).toContain("docs/governance/README.md");
    if (existsSync(join(process.cwd(), "CLAUDE.md"))) {
      expect(paths).toContain("CLAUDE.md");
    }
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
    if (existsSync(join(process.cwd(), "docs", "plans"))) {
      expect(paths).toContain("docs/plans/PLAN-L5-03-internal-processing.md");
      expect(paths).toContain("docs/plans/PLAN-L5-05-roster.md");
      expect(paths).toContain("docs/plans/PLAN-L5-06-skill.md");
      expect(paths).toContain("docs/plans/PLAN-L5-07-drift.md");
    }
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
    if (existsSync(join(process.cwd(), ".ut-tdd", "audit"))) {
      expect(paths.some((p) => p.startsWith(".ut-tdd/audit/") && p.endsWith(".md"))).toBe(true);
    }
    if (existsSync(join(process.cwd(), ".ut-tdd", "handover", "provider"))) {
      expect(
        paths.some((p) => p.startsWith(".ut-tdd/handover/provider/") && p.endsWith(".json")),
      ).toBe(true);
    }
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

describe("byte-level integrity guard (PLAN-L7-395: BOM / strict-UTF8 / control / JSON escape)", () => {
  const artifact = (path: string, bytes: Buffer): ReadabilityArtifact => ({
    path,
    bytes,
    text: bytes.toString("utf8"),
  });

  it("U-READ-005: flags a UTF-8 BOM that is invisible to the string-level markers", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# clean title\n")]);
    // The decoded text carries only a leading U+FEFF, which no MOJIBAKE_MARKER matches...
    expect(analyzeReadability([{ path: "a.md", text: bytes.toString("utf8") }]).ok).toBe(true);
    // ...so only the byte layer catches it.
    const result = analyzeByteIntegrity([artifact("a.md", bytes)]);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ path: "a.md", marker: "utf8-bom", line: 1 }]);
  });

  it("U-READ-005: flags UTF-16 LE and BE BOMs (the PowerShell Out-File default trap)", () => {
    const le = analyzeByteIntegrity([artifact("le.md", Buffer.from([0xff, 0xfe, 0x41, 0x00]))]);
    expect(le.violations.map((v) => v.marker)).toContain("utf16le-bom");
    const be = analyzeByteIntegrity([artifact("be.md", Buffer.from([0xfe, 0xff, 0x00, 0x41]))]);
    expect(be.violations.map((v) => v.marker)).toContain("utf16be-bom");
  });

  it("U-READ-006: flags non-well-formed UTF-8 bytes deterministically via strict decode", () => {
    // 0xC3 0x28 is an invalid 2-byte sequence.
    const result = analyzeByteIntegrity([artifact("x.md", Buffer.from([0x41, 0xc3, 0x28, 0x42]))]);
    expect(result.violations.map((v) => v.marker)).toContain("invalid-utf8");
  });

  it("U-READ-007: flags a NUL byte — the BOM-less UTF-16LE ASCII blind spot (IMP-086)", () => {
    // "hi" mis-saved as BOM-less UTF-16LE = h\0i\0. Valid UTF-8, no U+FFFD, no strict-decode throw.
    const bytes = Buffer.from([0x68, 0x00, 0x69, 0x00]);
    expect(analyzeReadability([{ path: "n.md", text: bytes.toString("utf8") }]).ok).toBe(true);
    const result = analyzeByteIntegrity([artifact("n.md", bytes)]);
    expect(result.violations.map((v) => v.marker)).toContain("control-character");
  });

  it("U-READ-007: flags a C1 control codepoint (valid UTF-8, so only visible after decode)", () => {
    const bytes = Buffer.from(`line1${String.fromCharCode(0x85)}line2`, "utf8");
    const result = analyzeByteIntegrity([artifact("c1.md", bytes)]);
    expect(result.violations.map((v) => v.marker)).toContain("control-character");
  });

  it("U-READ-008: flags JSON-escaped U+FFFD that raw-text regex misses but JSON.parse reveals", () => {
    // Raw bytes contain the escape sequence �, not a literal U+FFFD char.
    const bytes = Buffer.from('{"summary":"plan \\uFFFD here"}', "utf8");
    expect(analyzeReadability([{ path: "p.json", text: bytes.toString("utf8") }]).ok).toBe(true);
    const result = analyzeByteIntegrity([artifact("p.json", bytes)]);
    expect(result.violations.map((v) => v.marker)).toContain("json-escaped-mojibake");
  });

  it("U-READ-008: flags mojibake in JSON keys as well as values", () => {
    const bytes = Buffer.from('{"\\uFFFD-key":"clean"}', "utf8");
    expect(analyzeReadability([{ path: "k.json", text: bytes.toString("utf8") }]).ok).toBe(true);
    const result = analyzeByteIntegrity([artifact("k.json", bytes)]);
    expect(result.violations.map((v) => v.marker)).toContain("json-escaped-mojibake");
  });

  it("passes clean no-BOM UTF-8 with fullwidth-only Japanese", () => {
    const bytes = Buffer.from("# 監査\n工程表は直列で実行する。\n", "utf8");
    expect(analyzeByteIntegrity([artifact("ok.md", bytes)]).ok).toBe(true);
  });

  it("U-READ-009: double-encode mojibake passes the byte layer but the marker denylist still catches it", () => {
    const token = "蟾･遞玖｡ｨ"; // valid UTF-8, so byte integrity is clean
    const art = artifact("d.md", Buffer.from(token, "utf8"));
    expect(analyzeByteIntegrity([art]).ok).toBe(true);
    // analyzeArtifacts merges both layers: the denylist remains the sole net for this class.
    const merged = analyzeArtifacts([art]);
    expect(merged.ok).toBe(false);
    expect(merged.violations.map((v) => v.marker)).toContain("cp932-mojibake");
  });

  it("U-READ-010: propagates byte-layer violations through analyzeArtifacts", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# clean title\n")]);
    const result = analyzeArtifacts([artifact("bom.md", bytes)]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.marker)).toContain("utf8-bom");
  });

  it("U-READ-010: real repo artifacts pass the merged (string + byte) guard", () => {
    expect(analyzeArtifacts(loadSystemReadabilityDocs()).violations).toEqual([]);
    expect(analyzeArtifacts(loadRuntimeArtifactReadabilityDocs()).violations).toEqual([]);
  });

  it("U-READ-010: loader preserves file bytes so real BOM and JSON escape artifacts fail", () => {
    const root = mkdtempSync(join(tmpdir(), "ut-tdd-readability-bytes-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      mkdirSync(join(root, ".ut-tdd", "handover", "provider"), { recursive: true });
      writeFileSync(
        join(root, "docs", "bom.md"),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# clean\n")]),
      );
      writeFileSync(
        join(root, ".ut-tdd", "handover", "provider", "escaped.json"),
        Buffer.from('{"\\uFFFD-key":"clean"}', "utf8"),
      );

      const system = analyzeArtifacts(loadSystemReadabilityDocs(root));
      expect(system.ok).toBe(false);
      expect(system.violations).toContainEqual({
        path: join("docs", "bom.md"),
        marker: "utf8-bom",
        line: 1,
      });

      const runtime = analyzeArtifacts(loadRuntimeArtifactReadabilityDocs(root));
      expect(runtime.ok).toBe(false);
      expect(runtime.violations).toContainEqual({
        path: join(".ut-tdd", "handover", "provider", "escaped.json"),
        marker: "json-escaped-mojibake",
        line: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
