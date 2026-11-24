import { describe, expect, it } from "vitest";
import {
  type ControlRecord,
  checkControlSet,
  checkToolStaleness,
  isToolAdoptable,
  isToolDistributable,
  type ToolEntry,
  validateControlRecord,
  validateToolEntry,
} from "../src/ops-controls/controls.ts";
import {
  CONTROLS_4,
  CTRL_DB,
  CTRL_LOG2,
  CTRL_SEC,
  ctl,
  ev,
  ID_DB,
  ID_SEC,
  lic,
  one,
  PRESET_A,
  PRESET_B,
  pick,
  type Rec,
  TODAY,
  TOOL_OK,
  TOOL_PENDING,
  tool,
  without,
} from "./fixtures/ops-controls-fixtures.ts";

// Red (#1725): 候補 oracle を it.fails で登録する。対象は stub (src/ops-controls/controls.ts) で、Green の PR が it に戻す。
// 設計: docs/design/harness/L6-function-design/consumer-operations-controls.md
// テスト設計: docs/test-design/harness/L7-consumer-operations-controls-test-design.md

describe("consumer operations controls: 統制・ツール record (Red, #1725)", () => {
  it("fixture の前提: 統制 4 件と 2 本の preset が組める (Red の前提)", () => {
    expect(CONTROLS_4).toHaveLength(4);
    expect(Object.keys(PRESET_A.controlMap)).toHaveLength(4);
    expect(Object.keys(PRESET_B.controlMap)).toHaveLength(4);
  });

  it.fails("CANDIDATE-U-OPSCTL-001 正しい統制 record は finding を返さない", () => {
    for (const c of CONTROLS_4) expect(validateControlRecord(c)).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-002 id のパターン", () => {
    const bad = ["SEC-001", "OPS-S-001", "OPS-SEC-01", "ops-sec-001", "OPS-SECURI-001"];
    for (const id of bad)
      expect(pick(validateControlRecord(ctl(CTRL_SEC, { id })))).toEqual(
        one("control.id_invalid", "id"),
      );
    for (const id of ["OPS-LOG-999", "OPS-ABCDE-000"])
      expect(validateControlRecord(ctl(CTRL_SEC, { id }))).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-003 domain の enum", () => {
    const all = [
      "log-observability",
      "infra-iac",
      "operations",
      "test-evidence",
      "database",
      "security",
      "code-quality",
      "api-release",
      "data-platform",
      "docs-adr",
      "product-analytics",
    ];
    for (const domain of all) expect(validateControlRecord(ctl(CTRL_SEC, { domain }))).toEqual([]);
    for (const domain of ["security ", "Security", ""])
      expect(pick(validateControlRecord(ctl(CTRL_SEC, { domain })))).toEqual(
        one("control.domain_unknown", "domain"),
      );
  });

  it.fails("CANDIDATE-U-OPSCTL-004 outcome の空白", () => {
    for (const outcome of ["", "   ", "\t\n"])
      expect(pick(validateControlRecord(ctl(CTRL_SEC, { outcome })))).toEqual(
        one("control.outcome_blank", "outcome"),
      );
    expect(validateControlRecord(ctl(CTRL_SEC, { outcome: "x" }))).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-005 tier の範囲と欠落", () => {
    for (const minLevel of [0, 5])
      expect(validateControlRecord(ctl(CTRL_SEC, { tier: { nfrItem: "X-1", minLevel } }))).toEqual(
        [],
      );
    const bad = [
      ctl(CTRL_SEC, { tier: { nfrItem: "X-1", minLevel: 6 } }),
      ctl(CTRL_SEC, { tier: { nfrItem: "X-1", minLevel: -1 } }),
      ctl(CTRL_SEC, { tier: { nfrItem: "X-1", minLevel: 2.5 } }),
      ctl(CTRL_SEC, { tier: { nfrItem: "  ", minLevel: 2 } }),
      without(CTRL_SEC, "tier"),
    ];
    for (const r of bad)
      expect(pick(validateControlRecord(r))).toEqual(one("control.tier_invalid", "tier"));
  });

  it.fails("CANDIDATE-U-OPSCTL-006 layers の範囲・重複・空", () => {
    const f = (layers: string[]) => pick(validateControlRecord(ctl(CTRL_SEC, { layers })));
    expect(f([])).toEqual(one("control.layers_empty", "layers"));
    expect(f(["L3"])).toEqual(one("control.layer_invalid", "L3"));
    expect(f(["L15"])).toEqual(one("control.layer_invalid", "L15"));
    expect(f(["l7"])).toEqual(one("control.layer_invalid", "l7"));
    expect(f(["L7", "L7"])).toEqual(one("control.layer_duplicate", "L7"));
    expect(f(["L4", "L14"])).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-007 stage と appliesTo", () => {
    const f = (patch: Rec) => pick(validateControlRecord(ctl(CTRL_SEC, patch)));
    expect(f({ stage: "enforce" })).toEqual([]);
    expect(f({ stage: "warn" })).toEqual(one("control.stage_invalid", "stage"));
    expect(f({ stage: "Enforce" })).toEqual(one("control.stage_invalid", "stage"));
    expect(f({ appliesTo: [] })).toEqual(one("control.applies_to_invalid", "appliesTo"));
    expect(f({ appliesTo: ["server", "edge"] })).toEqual(
      one("control.applies_to_invalid", "appliesTo"),
    );
  });

  it.fails("CANDIDATE-U-OPSCTL-008 evidence の形", () => {
    const bad = [
      ev(CTRL_SEC, { format: "text" }),
      ev(CTRL_SEC, { schemaRef: " " }),
      ev(CTRL_SEC, { bindsTo: [] }),
      ev(CTRL_SEC, { bindsTo: ["head", "x"] }),
      without(CTRL_SEC, "evidence"),
    ];
    for (const r of bad)
      expect(pick(validateControlRecord(r))).toEqual(one("control.evidence_invalid", "evidence"));
    expect(validateControlRecord(ev(CTRL_SEC, { format: "junit-xml" }))).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-009 runtime の統制は deploy-receipt に束縛される", () => {
    expect(validateControlRecord(CTRL_LOG2)).toEqual([]);
    expect(pick(validateControlRecord(ev(CTRL_LOG2, { bindsTo: ["head"] })))).toEqual(
      one("control.runtime_unbound", "evidence.bindsTo"),
    );
    expect(validateControlRecord(ev(CTRL_LOG2, { bindsTo: ["deploy-receipt"] }))).toEqual([]);
    expect(validateControlRecord(ev(CTRL_SEC, { bindsTo: ["head", "deploy-receipt"] }))).toEqual(
      [],
    );
    for (const input of [null, "x", []])
      expect(pick(validateControlRecord(input))).toEqual(one("control.not_object", ""));
  });

  it.fails("CANDIDATE-U-OPSCTL-010 統制 id の重複", () => {
    const dup = (list: ControlRecord[]) => pick(checkControlSet(list));
    expect(dup(CONTROLS_4)).toEqual([]);
    expect(dup([CTRL_SEC, CTRL_DB, CTRL_SEC, CTRL_SEC])).toEqual([
      ...one("control.duplicate_id", ID_SEC),
      ...one("control.duplicate_id", ID_SEC),
    ]);
    expect(dup([CTRL_DB, CTRL_SEC, CTRL_DB])).toEqual(one("control.duplicate_id", ID_DB));
    expect(dup([])).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-011 pending-primary は不備にしない", () => {
    expect(validateToolEntry(TOOL_OK, TODAY)).toEqual([]);
    expect(validateToolEntry(TOOL_PENDING, TODAY)).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-012 checkedAt の形式と実在", () => {
    expect(validateToolEntry(tool({ checkedAt: "2026-11-17" }), TODAY)).toEqual([]);
    for (const checkedAt of [
      "2026-11-18",
      "2026-02-30",
      "2026/11/01",
      "2026-1-1",
      "",
      "2026-13-01",
    ])
      expect(pick(validateToolEntry(tool({ checkedAt }), TODAY))).toEqual(
        one("tool.checked_at_invalid", "checkedAt"),
      );
  });

  it.fails("CANDIDATE-U-OPSCTL-013 lifecycle と verification の enum", () => {
    const f = (patch: Rec) => pick(validateToolEntry(tool(patch), TODAY));
    expect(f({ lifecycle: "deprecated" })).toEqual(one("tool.lifecycle_unknown", "lifecycle"));
    expect(f({ lifecycle: "" })).toEqual(one("tool.lifecycle_unknown", "lifecycle"));
    expect(f({ verification: "ok" })).toEqual(one("tool.verification_unknown", "verification"));
    for (const lifecycle of [
      "available",
      "new-signups-stopped",
      "end-of-support-scheduled",
      "license-changed",
    ])
      expect(f({ lifecycle })).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-014 sourceUrl", () => {
    const f = (t: ToolEntry) => pick(validateToolEntry(t, TODAY));
    expect(f(tool({ sourceUrl: null }))).toEqual(one("tool.source_missing", "sourceUrl"));
    expect(f(tool({ sourceUrl: "http://example.test/x" }))).toEqual(
      one("tool.source_not_https", "sourceUrl"),
    );
    expect(f(tool({ sourceUrl: "example.test/x" }))).toEqual(
      one("tool.source_not_https", "sourceUrl"),
    );
    expect(f({ ...TOOL_PENDING, sourceUrl: "http://example.test/x" })).toEqual(
      one("tool.source_not_https", "sourceUrl"),
    );
    expect(f({ ...TOOL_PENDING, sourceUrl: "https://example.test/x" })).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-015 license の承認の記録", () => {
    const f = (t: ToolEntry) => pick(validateToolEntry(t, TODAY));
    const unrecorded = one("tool.license_unrecorded", "license.recordRef");
    expect(f(lic({ approval: "approved" }))).toEqual(unrecorded);
    expect(f(lic({ approval: "approved", recordRef: "  " }))).toEqual(unrecorded);
    expect(f(lic({ approval: "approved", recordRef: "ADR-X" }))).toEqual([]);
    expect(f(lic({ approval: "none" }))).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-016 isToolAdoptable は 3 条件を全て要る", () => {
    expect(isToolAdoptable(TOOL_OK)).toBe(true);
    expect(isToolAdoptable(tool({ verification: "pending-primary" }))).toBe(false);
    for (const lifecycle of ["new-signups-stopped", "end-of-support-scheduled", "license-changed"])
      expect(isToolAdoptable(tool({ lifecycle }))).toBe(false);
    expect(isToolAdoptable(lic({ approval: "none" }))).toBe(false);
    expect(isToolAdoptable(lic({ approval: "approved" }))).toBe(false);
    expect(isToolAdoptable(lic({ approval: "approved", recordRef: " " }))).toBe(false);
  });

  it.fails("CANDIDATE-U-OPSCTL-017 isToolDistributable は配布の承認だけを見る", () => {
    const d = (license: Rec, extra: Rec = {}) => isToolDistributable(tool({ license, ...extra }));
    expect(d({ distribution: "reference-only", approval: "none" })).toBe(true);
    expect(d({ distribution: "vendored", approval: "none" })).toBe(false);
    expect(d({ distribution: "vendored", approval: "approved" })).toBe(false);
    expect(d({ distribution: "vendored", approval: "approved", recordRef: "ADR-X" })).toBe(true);
    expect(
      d(
        { distribution: "vendored", approval: "approved", recordRef: "ADR-X" },
        { lifecycle: "license-changed", verification: "pending-primary" },
      ),
    ).toBe(true);
  });

  it.fails("CANDIDATE-U-OPSCTL-018 鮮度の境界", () => {
    const f = (checkedAt: string) => pick(checkToolStaleness(tool({ checkedAt }), TODAY, 30));
    expect(f("2026-10-18")).toEqual([]);
    expect(f("2026-10-17")).toEqual(one("tool.stale", "checkedAt"));
    expect(f("2026-11-17")).toEqual([]);
    expect(f("bad")).toEqual(one("tool.checked_at_invalid", "checkedAt"));
  });
});
