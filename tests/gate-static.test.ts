import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeLayerPairGate, evaluateStaticGate, readCoverageSummary } from "../src/gate/static";
import type { PairDoc } from "../src/vmodel/lint";

const cliPath = join(process.cwd(), "src", "cli.ts");

function runCli(args: string[]) {
  if (process.platform === "win32") {
    const cmdExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return spawnSync(cmdExe, ["/d", "/c", "bun", cliPath, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  }
  return spawnSync("bun", [cliPath, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

const doc = (
  path: string,
  layer: string,
  pairArtifact: string | null,
  status = "confirmed",
): PairDoc => ({ path, layer, pairArtifact, status });

describe("static gates", () => {
  it("wires G1 to deterministic pair + trace lint", () => {
    const result = evaluateStaticGate({ gate: "G1", repoRoot: process.cwd() });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.messages.join("\n")).toContain("g1-pair");
    expect(result.messages.join("\n")).toContain("g1-trace");
  });

  it("wires G3 to deterministic pair + trace lint", () => {
    const result = evaluateStaticGate({ gate: "G3", repoRoot: process.cwd() });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.messages.join("\n")).toContain("g3-pair");
    expect(result.messages.join("\n")).toContain("g3-trace");
  });

  it("wires G2/G4/G5/G6 to deterministic layer pair gates", () => {
    for (const gate of ["G2", "G4", "G5", "G6"]) {
      const result = evaluateStaticGate({ gate, repoRoot: process.cwd() });
      expect(result.applicable).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.messages.join("\n")).toContain(`${gate.toLowerCase()}-pair`);
    }
  });

  it("fails a layer pair gate when pair evidence is missing", () => {
    const result = analyzeLayerPairGate(
      [doc("docs/design/harness/L4-basic-design/function.md", "L4", null)],
      "G4",
      "L4",
    );
    expect(result.ok).toBe(false);
    expect(result.orphanPaths).toEqual(["docs/design/harness/L4-basic-design/function.md"]);
  });

  it("fails G2 when the wireframe mock self-pair is missing", () => {
    const result = analyzeLayerPairGate(
      [
        doc(
          "docs/design/harness/L2-screen/screen-list.md",
          "L2",
          "docs/design/harness/L2-screen/wireframe.md",
          "placeholder",
        ),
      ],
      "G2",
      "L2",
    );
    expect(result.ok).toBe(false);
    expect(result.mockMissing).toBe(true);
  });

  it("fails G7 closed when coverage evidence is missing", () => {
    const missing = join(tmpdir(), `missing-${Date.now()}-coverage-summary.json`);
    const result = evaluateStaticGate({
      gate: "G7",
      repoRoot: process.cwd(),
      coverageSummaryPath: missing,
    });
    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("coverage summary not found");
  });

  it("fails unknown gates closed instead of passing an unregistered check", () => {
    const result = evaluateStaticGate({ gate: "G999", repoRoot: process.cwd() });

    expect(result.applicable).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("no deterministic check registered");
  });

  it("allows known review-only gates to rely on the review tier", () => {
    for (const gate of ["G0.5", "R4"]) {
      const result = evaluateStaticGate({ gate, repoRoot: process.cwd() });

      expect(result.applicable).toBe(false);
      expect(result.passed).toBe(true);
      expect(result.messages.join("\n")).toContain("review-tier gate");
    }
  });

  it("U-GATE-005: fails closed when a deterministic static check cannot run", () => {
    const result = evaluateStaticGate({
      gate: "G1",
      repoRoot: join(tmpdir(), "missing-gate-root"),
    });

    expect(result.applicable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.messages.join("\n")).toContain("deterministic check could not run");
  });

  it("U-GATE-006: reports invalid checklist YAML as a gate failure instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ut-tdd-checklist-"));
    const checklist = join(dir, "bad-review-checklist.yaml");
    writeFileSync(checklist, "items: [");

    const result = runCli([
      "gate",
      "G4",
      "--mode",
      "codex-only",
      "--checklist",
      checklist,
      "--json",
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("review checklist - violation");
    expect(result.stdout).toContain('"passed": false');
    expect(result.stderr).not.toContain("error: script");
  });

  it("rejects coverage below the G7 threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "ut-tdd-coverage-"));
    const summary = join(dir, "coverage-summary.json");
    writeFileSync(summary, JSON.stringify({ total: { lines: { pct: 79.99 } } }));
    const result = readCoverageSummary(summary, 80);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("79.99% < 80%");
  });

  it("accepts coverage at the G7 threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "ut-tdd-coverage-"));
    const summary = join(dir, "coverage-summary.json");
    writeFileSync(summary, JSON.stringify({ total: { lines: { pct: 80 } } }));
    const result = readCoverageSummary(summary, 80);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("80% >= 80%");
  });

  it("keeps gate command docs aligned with static gate implementation", () => {
    const functionDoc = readFileSync(
      join(process.cwd(), "docs", "design", "harness", "L4-basic-design", "function.md"),
      "utf8",
    );
    const gateRow = functionDoc
      .split(/\r?\n/)
      .find((line) => line.includes("`ut-tdd gate <G-ID>`"));
    expect(gateRow).toContain("deterministic static gate");
    expect(gateRow).not.toContain("gate checks 全量は後続");
    expect(gateRow).not.toContain("部分実装");
  });
});
