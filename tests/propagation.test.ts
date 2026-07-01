import { describe, expect, it } from "vitest";
import {
  analyzePropagation,
  extractSignals,
  loadPropagationDocs,
  propagationMessages,
} from "../src/lint/propagation";

const CONCEPT = `
## §2.6 signal routing
| signal | mode | 備考 |
|---|---|---|
| \`agent_runaway\` / \`forced_stop\` | Recovery | x |
| \`requirement_undefined\` / \`design_uncertain\` | Discovery | y |
| \`interrupt\` (subtype=design_gap/po_change) | 分岐 | z |

## §2.7 別表 (signal でない)
| kind | drive |
|---|---|
| \`reverse\` | \`fullstack\` |
`;

const REQ_MATCH = `
## §7.8.1 route-map
| signal | mode | 補足 |
|---|---|---|
| \`agent_runaway\` / \`forced_stop\` | recovery | x |
| \`requirement_undefined\` / \`design_uncertain\` | discovery | y |
| \`interrupt\` (+\`subtype=design_gap\`/\`po_change\`) | 分岐 | z |
`;

describe("U-PROP-001 extractSignals", () => {
  it("signal/mode テーブルのみから signal 列 token を抽出 (別表/interrupt 行は除外)", () => {
    const s = extractSignals(CONCEPT);
    expect([...s].sort()).toEqual([
      "agent_runaway",
      "design_uncertain",
      "forced_stop",
      "requirement_undefined",
    ]);
    // 別表の reverse/fullstack や interrupt subtype は拾わない
    expect(s.has("reverse")).toBe(false);
    expect(s.has("design_gap")).toBe(false);
  });
});

describe("U-PROP-002 analyzePropagation", () => {
  it("両 doc の signal 語彙一致 → ok", () => {
    const r = analyzePropagation(CONCEPT, REQ_MATCH);
    expect(r.ok).toBe(true);
    expect(r.conceptOnly).toEqual([]);
    expect(r.requirementsOnly).toEqual([]);
  });

  it("concept にあり requirements に無い → conceptOnly + ok=false", () => {
    const reqMissing = REQ_MATCH.replace(" / `forced_stop`", "");
    const r = analyzePropagation(CONCEPT, reqMissing);
    expect(r.conceptOnly).toContain("forced_stop");
    expect(r.ok).toBe(false);
  });

  it("requirements にあり concept に無い → requirementsOnly + ok=false", () => {
    const conceptMissing = CONCEPT.replace(" / `design_uncertain`", "");
    const r = analyzePropagation(conceptMissing, REQ_MATCH);
    expect(r.requirementsOnly).toContain("design_uncertain");
    expect(r.ok).toBe(false);
  });
});

describe("U-PROP-003 messages", () => {
  it("一致 → OK / 不一致 → warn 文言", () => {
    expect(
      propagationMessages(analyzePropagation(CONCEPT, REQ_MATCH)).some((m) => m.includes("OK")),
    ).toBe(true);
    const reqMissing = REQ_MATCH.replace(" / `forced_stop`", "");
    expect(
      propagationMessages(analyzePropagation(CONCEPT, reqMissing)).some((m) =>
        m.includes("未伝播"),
      ),
    ).toBe(true);
  });
});

describe("U-PROP-004 実 repo の L0⇔L3 signal 伝播 (回帰ガード)", () => {
  it("concept §2.6 ⇔ requirements §7.8.1 の signal 語彙が一致 (conceptOnly/requirementsOnly = 0)", () => {
    const d = loadPropagationDocs();
    const r = analyzePropagation(d.conceptText, d.requirementsText);
    expect({ conceptOnly: r.conceptOnly, requirementsOnly: r.requirementsOnly }).toEqual({
      conceptOnly: [],
      requirementsOnly: [],
    });
  });
});
