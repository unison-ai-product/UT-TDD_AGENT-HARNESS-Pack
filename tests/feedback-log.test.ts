import { describe, expect, it } from "vitest";
import { analyzeFeedbackLog, parseFeedbackEntries } from "../src/lint/feedback-log";

/**
 * U-FBLOG: feedback-log discipline lint (IMP-085、A-138 ITEM-3)。
 * docs/feedback-log.md の各 FB が実際にドメスティック化されたか (open/空/dangling) を fail-close 検査。
 */

const HEADER = `# Feedback Log\n\n## エントリ\n\n| FB-ID | 日付 | source | フィードバック | lesson | domesticated to | status |\n|---|---|---|---|---|---|---|\n`;
const BACKLOG = `## §1 backlog\n\n| ID | x |\n|---|---|\n| **IMP-082** | a |\n| **IMP-085** | b |\n`;

function input(rows: string, backlog = BACKLOG, exists: (p: string) => boolean = () => true) {
  return { md: HEADER + rows, backlogMd: backlog, existsPath: exists };
}

describe("U-FBLOG: feedback-log discipline lint", () => {
  it("U-FBLOG-001: 全 FB が domesticated + 参照実在 → ok", () => {
    const rows =
      "| **FB-001** | 2026-06-08 | PO | fb | lesson | memory: [[x]] / IMP-082 | domesticated |\n" +
      "| **FB-002** | 2026-06-08 | PO | fb | lesson | doc: `docs/feedback-log.md` | domesticated |\n";
    const r = analyzeFeedbackLog(input(rows));
    expect(r.ok).toBe(true);
    expect(r.total).toBe(2);
  });

  it("U-FBLOG-002: status=open は未ドメスティック化として fail-close", () => {
    const rows = "| **FB-003** | 2026-06-08 | PO | fb | lesson | memory: [[x]] | open |\n";
    const r = analyzeFeedbackLog(input(rows));
    expect(r.ok).toBe(false);
    expect(r.undomesticated).toContain("FB-003");
  });

  it("U-FBLOG-003: domesticated 空 (status≠superseded) は fail-close、superseded は許容", () => {
    const open = analyzeFeedbackLog(
      input("| **FB-004** | 2026-06-08 | PO | fb | lesson | - | domesticated |\n"),
    );
    expect(open.undomesticated).toContain("FB-004");
    const sup = analyzeFeedbackLog(
      input("| **FB-005** | 2026-06-08 | PO | fb | lesson | - | superseded |\n"),
    );
    expect(sup.ok).toBe(true);
  });

  it("U-FBLOG-004: domesticated to の IMP-NNN が backlog に不在 → dangling", () => {
    const rows = "| **FB-006** | 2026-06-08 | PO | fb | lesson | IMP-999 | domesticated |\n";
    const r = analyzeFeedbackLog(input(rows));
    expect(r.ok).toBe(false);
    expect(r.danglingImpRefs).toEqual([{ id: "FB-006", ref: "IMP-999" }]);
  });

  it("U-FBLOG-005: backtick path 参照が repo に不在 → missingPathRef", () => {
    const rows =
      "| **FB-007** | 2026-06-08 | PO | fb | lesson | doc: `docs/ghost.md` | domesticated |\n";
    const r = analyzeFeedbackLog(input(rows, BACKLOG, (p) => p !== "docs/ghost.md"));
    expect(r.ok).toBe(false);
    expect(r.missingPathRefs).toEqual([{ id: "FB-007", ref: "docs/ghost.md" }]);
  });

  it("U-FBLOG-006: 不正 status / 重複 ID / 列欠落を検出", () => {
    const rows =
      "| **FB-008** | 2026-06-08 | PO | fb | lesson | IMP-082 | bogus |\n" +
      "| **FB-008** | 2026-06-08 | PO | fb | lesson | IMP-082 | domesticated |\n";
    const r = analyzeFeedbackLog(input(rows));
    expect(r.invalidStatus).toEqual([{ id: "FB-008", status: "bogus" }]);
    expect(r.duplicateIds).toContain("FB-008");
    expect(r.ok).toBe(false);
  });

  it("U-FBLOG-007: 実 repo の docs/feedback-log.md は全件 domesticated (green)", () => {
    const r = analyzeFeedbackLog({
      md: require("node:fs").readFileSync("docs/feedback-log.md", "utf-8"),
      backlogMd: require("node:fs").readFileSync("docs/improvement-backlog.md", "utf-8"),
      existsPath: (p: string) => require("node:fs").existsSync(p),
    });
    expect(r.ok).toBe(true);
    expect(r.undomesticated).toEqual([]);
  });

  it("U-FBLOG-008: parseFeedbackEntries は FB 行のみ抽出 (header/区切りは無視)", () => {
    const rows = "| **FB-009** | 2026-06-08 | PO | fb | lesson | IMP-082 | domesticated |\n";
    expect(parseFeedbackEntries(HEADER + rows)).toHaveLength(1);
  });
});
