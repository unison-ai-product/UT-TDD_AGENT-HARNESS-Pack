/**
 * plan_id 命名規約の enforcement (§1.10 A、phase-aware)。
 * 旧 stale regex (PLAN-NNN flat) では実態の PLAN-L{N}-{NN} を拾えず、real file に enforce も
 * されていなかった (A-94)。本 test が docs/plans/ 全件を新基準で機械検証し、
 * 「ID 単体で phase 判別 → state(DB) が phase↔PLAN を拾える」を保証する。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planIdSchema } from "../src/schema/frontmatter";

const plansDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "plans");

function extract(content: string, key: string): string | undefined {
  const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}

describe("plan_id 命名規約 (§1.10 A、DB 拾い上げ保証)", () => {
  const files = readdirSync(plansDir).filter((f) => f.endsWith(".md"));

  it("docs/plans/ に PLAN ファイルが存在する (非空虚)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("全 PLAN の plan_id が §1.10 A 形式に適合 (PLAN-<token>-<NN>-slug、token=L0〜L14/DISCOVERY/REVERSE/RECOVERY/M)", () => {
    const violations: string[] = [];
    for (const f of files) {
      const planId = extract(readFileSync(join(plansDir, f), "utf8"), "plan_id");
      if (!planId || !planIdSchema.safeParse(planId).success) {
        violations.push(`${f}: plan_id="${planId ?? "(欠落)"}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("plan_id の token が frontmatter と一致 (L{N}↔layer / 駆動トークン↔kind+layer=cross、§1.10 A)", () => {
    const driveTokenToKind: Record<string, string> = {
      DISCOVERY: "poc",
      REVERSE: "reverse",
      RECOVERY: "recovery",
    };
    const violations: string[] = [];
    for (const f of files) {
      const content = readFileSync(join(plansDir, f), "utf8");
      const planId = extract(content, "plan_id");
      const layer = extract(content, "layer");
      const kind = extract(content, "kind");
      if (!planId || !layer) continue;
      const tok = planId.match(/^PLAN-(L(?:[0-9]|1[0-4])|DISCOVERY|REVERSE|RECOVERY|M)-/)?.[1];
      if (!tok || tok === "M") continue; // M = master plan、layer は自由
      if (tok in driveTokenToKind) {
        // 横断駆動: token↔kind 一致 + layer=cross
        if (kind !== driveTokenToKind[tok])
          violations.push(`${f}: token=${tok} ↔ kind=${kind} (expected ${driveTokenToKind[tok]})`);
        if (layer !== "cross")
          violations.push(`${f}: token=${tok} は layer=cross 必須 (現 ${layer})`);
      } else if (layer !== tok) {
        // Forward 工程: token↔layer 一致
        violations.push(`${f}: token=${tok} ↔ layer=${layer}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("ファイル名 (拡張子除く) が plan_id と一致 (state 拾い上げの前提)", () => {
    const violations: string[] = [];
    for (const f of files) {
      const planId = extract(readFileSync(join(plansDir, f), "utf8"), "plan_id");
      const base = f.replace(/\.md$/, "");
      if (planId && planId !== base) violations.push(`${f}: plan_id=${planId}`);
    }
    expect(violations).toEqual([]);
  });
});
