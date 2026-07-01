import { describe, expect, it } from "vitest";
import {
  analyzeGateConfirm,
  type ConfirmDoc,
  gateConfirmMessages,
  layerToGate,
  parseGateStatuses,
} from "../src/lint/gate-confirm";

const doc = (over: Partial<ConfirmDoc>): ConfirmDoc => ({
  file: "docs/design/harness/L5-detailed-design/x.md",
  layer: "L5",
  status: "confirmed",
  kind: "design",
  ...over,
});

describe("gate-confirm lint (IMP-079)", () => {
  it("U-GCONF-001: parses only the gate-design §2 ledger", () => {
    const rows = parseGateStatuses(`
## §1 spec
| Gate | Layer | Summary |
|---|---|---|
| **G4** | L4 | 4 sub-doc |

## §2 ledger
| Gate | Layer | Status | Evidence |
|---|---|---|---|
| **G4** | L4 | ✅ PASS | A-101 |
| G5 | L5 | ⏸ park | - |
`);
    expect(rows).toEqual([
      { gate: "G4", layer: "L4", status: "✅ PASS", pass: true },
      { gate: "G5", layer: "L5", status: "⏸ park", pass: false },
    ]);
  });

  it("U-GCONF-001b: maps the current §2 ledger shape from gate to layer", () => {
    const rows = parseGateStatuses(`
## §2 ゲート台帳
| Gate | Status | Evidence | Note |
|---|---|---|---|
| G1 | ✅ PASS (再確定) | A-100 | ok |
| G5 | ⏸ park | A-70 | parked |
`);
    expect(rows).toEqual([
      { gate: "G1", layer: "L1", status: "✅ PASS (再確定)", pass: true },
      { gate: "G5", layer: "L5", status: "⏸ park", pass: false },
    ]);
  });

  it("U-GCONF-001c: parses a gate cell even when generated text leaves a suffix", () => {
    const rows = parseGateStatuses(`
## section 2 ledger
| Gate | Status | Evidence |
|---|---|---|
| G6 stray | not reached | - |
`);
    expect(rows).toEqual([{ gate: "G6", layer: "L6", status: "not reached", pass: false }]);
  });

  it("U-GCONF-002: maps layer to gate", () => {
    expect(layerToGate("L5")).toBe("G5");
    expect(layerToGate("cross")).toBeNull();
  });

  it("U-GCONF-003: confirmed doc on parked gate becomes a violation", () => {
    const r = analyzeGateConfirm({
      gateText: "| G5 | L5 | park | - |\n",
      docs: [doc({ layer: "L5", status: "confirmed" })],
    });
    expect(r.violations).toEqual([
      {
        file: "docs/design/harness/L5-detailed-design/x.md",
        layer: "L5",
        gate: "G5",
        gateStatus: "park",
      },
    ]);
    expect(r.ok).toBe(false);
  });

  it("U-GCONF-004: PASS gate is ok", () => {
    const r = analyzeGateConfirm({
      gateText: "| G5 | L5 | PASS | A-200 |\n",
      docs: [doc({ layer: "L5", status: "confirmed" })],
    });
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("U-GCONF-005: parse failure is a fail-closed violation", () => {
    const r = analyzeGateConfirm({ gateText: "no table", docs: [doc({})] });
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(false);
    expect(gateConfirmMessages(r)[0]).toContain("violation");
  });

  it("U-GCONF-006: draft doc is outside the check", () => {
    const r = analyzeGateConfirm({
      gateText: "| G5 | L5 | park | - |\n",
      docs: [doc({ status: "draft" })],
    });
    expect(r.violations).toEqual([]);
  });
});
