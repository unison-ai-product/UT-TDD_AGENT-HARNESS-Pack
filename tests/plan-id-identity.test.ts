import { describe, expect, it } from "vitest";
import { parsePlanIdIdentity, parseReservablePlanIdIdentity } from "../src/schema/plan-id.ts";

describe("PLAN draft shared identity (PLAN-L7-435)", () => {
  it.each([
    ["PLAN-L0-01-charter", "L0", "01", 1],
    ["PLAN-L7-999-implementation", "L7", "999", 999],
    ["PLAN-L14-42-value", "L14", "42", 42],
    ["PLAN-DISCOVERY-05-spike", "DISCOVERY", "05", 5],
    ["PLAN-REVERSE-395-backfill", "REVERSE", "395", 395],
    ["PLAN-RECOVERY-01-repair", "RECOVERY", "01", 1],
    ["PLAN-M-00-verify-cutover", "M", "00", 0],
  ])("U-PADM-061: %sを正本token/ordinalへ無損失分解する", (planId, token, ordinalText, ordinal) => {
    expect(parsePlanIdIdentity(planId)).toEqual({ token, namespace: token, ordinalText, ordinal });
  });

  it("U-PADM-062: reservation可能IDと凍結M系列・不正IDを分離しzero-paddingを同一座標化する", () => {
    expect(parseReservablePlanIdIdentity("PLAN-RECOVERY-01-repair")).toMatchObject({
      namespace: "RECOVERY",
      ordinal: 1,
    });
    expect(parseReservablePlanIdIdentity("PLAN-M-00-verify-cutover")).toBeNull();
    expect(parseReservablePlanIdIdentity("PLAN-M-01-cutover-backfill")).toBeNull();
    expect(parseReservablePlanIdIdentity("PLAN-M-02-invented")).toBeNull();
    expect(parseReservablePlanIdIdentity("PLAN-RECOVERY-070-repair")?.ordinal).toBe(
      parseReservablePlanIdIdentity("PLAN-RECOVERY-70-repair")?.ordinal,
    );
    for (const invalid of [
      "PLAN-RECOVERY-0-repair",
      "PLAN-RECOVER-01-repair",
      "PLAN-RECOVERY-01x",
      "PLAN-L15-01-invalid",
      "PLAN-RECOVERY-01-BadSlug",
    ]) {
      expect(parsePlanIdIdentity(invalid)).toBeNull();
      expect(parseReservablePlanIdIdentity(invalid)).toBeNull();
    }
  });
});
