import { describe, expect, it } from "vitest";
import {
  checkControlSet,
  checkLogProfile,
  checkLogRecord,
  checkPresetMapping,
  type LogProfile,
  lintMigration,
  type Preset,
  requiresPoApproval,
  resolveControlSeverity,
  type Stage,
  validateControlRecord,
} from "../src/ops-controls/controls.ts";
import {
  BASE_LOG,
  CONTROLS_4,
  CTRL_CRASH,
  CTRL_LOG2,
  CTRL_SEC,
  ci,
  ctl,
  dropKey,
  entries,
  entry0,
  ID_CRASH,
  ID_DB,
  ID_LOG2,
  ID_SEC,
  ID_UNKNOWN,
  one,
  PRESET_A,
  PRESET_B,
  PROFILE_OK,
  pick,
  type Rec,
  toolsOf,
  withMap,
  without,
  withTool,
} from "./fixtures/ops-controls-fixtures.ts";

// Red (#1725): 候補 oracle を it.fails で登録する。対象は stub (src/ops-controls/controls.ts) で、Green の PR が it に戻す。
// 設計: docs/design/harness/L6-function-design/consumer-operations-controls.md
// テスト設計: docs/test-design/harness/L7-consumer-operations-controls-test-design.md

describe("consumer operations controls: preset・ログ・migration (Red, #1725)", () => {
  it.fails("CANDIDATE-U-OPSCTL-019 正しい対応表は finding を返さない", () => {
    expect(checkPresetMapping(CONTROLS_4, PRESET_A)).toEqual([]);
    expect(checkPresetMapping(CONTROLS_4, PRESET_B)).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-020 落とした統制・未知・空欄・na の理由", () => {
    const f = (p: Preset) => pick(checkPresetMapping(CONTROLS_4, p));
    expect(f(dropKey(PRESET_A, ID_DB))).toEqual(one("preset.control_unmapped", ID_DB));
    expect(f(withMap(PRESET_A, { [ID_UNKNOWN]: { na: "x" } }))).toEqual(
      one("preset.control_unknown", ID_UNKNOWN),
    );
    expect(f(entry0(PRESET_A, ID_SEC, { ruleId: "" }))).toEqual(
      one("preset.rule_id_missing", `${ID_SEC}:secret-scanner`),
    );
    expect(f(withMap(PRESET_A, { [ID_DB]: { na: "  " } }))).toEqual(
      one("preset.na_reason_missing", ID_DB),
    );
    expect(f(withMap(PRESET_A, { [ID_DB]: { na: "別の方法で満たす" } }))).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-021 未登録・採用不可のツール", () => {
    const f = (p: Preset) => pick(checkPresetMapping(CONTROLS_4, p));
    expect(f(entry0(PRESET_A, ID_SEC, { tool: "ghost" }))).toEqual(
      one("preset.tool_unknown", `${ID_SEC}:ghost`),
    );
    const pending = {
      verification: "pending-primary",
      license: { distribution: "reference-only", approval: "none" },
    };
    expect(f(withTool(PRESET_A, "migration-lint", pending))).toEqual(
      one("preset.tool_not_adoptable", `${ID_DB}:migration-lint`),
    );
    expect(
      f(withTool(PRESET_A, "secret-scanner", { lifecycle: "end-of-support-scheduled" })),
    ).toEqual(one("preset.tool_not_adoptable", `${ID_SEC}:secret-scanner`));
  });

  it.fails("CANDIDATE-U-OPSCTL-022 target で対象の統制が決まる", () => {
    const controls = [...CONTROLS_4, CTRL_CRASH];
    expect(checkPresetMapping(controls, PRESET_A)).toEqual([]);
    const client: Preset = {
      id: "client",
      target: "client",
      tools: toolsOf(["secret-scanner", "crash-reporter"]),
      controlMap: {
        [ID_CRASH]: [ci("crash-reporter", "crash.reported")],
        [ID_SEC]: [ci("secret-scanner", "generic-api-key")],
      },
    };
    expect(checkPresetMapping(controls, client)).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-023 runtime の統制は runtime の写像を要る", () => {
    const f = (p: Preset) => pick(checkPresetMapping(CONTROLS_4, p));
    const missing = one("preset.runtime_scope_missing", ID_LOG2);
    const ciOnly = [ci("iac-assert", "log-group.retention-set")];
    expect(f(withMap(PRESET_A, { [ID_LOG2]: ciOnly }))).toEqual(missing);
    const manual = { tool: "observer", ruleId: "r", scope: "manual-review" };
    expect(f(withMap(PRESET_A, { [ID_LOG2]: [...ciOnly, manual] }))).toEqual(missing);
    const allManual = entries(PRESET_A, ID_SEC).map((e) => ({ ...e, scope: "manual-review" }));
    expect(f(withMap(PRESET_A, { [ID_SEC]: allManual }))).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-024 ログ profile", () => {
    const f = (p: object) => pick(checkLogProfile(p as LogProfile));
    expect(f(PROFILE_OK)).toEqual([]);
    for (const semconvVersion of ["", "latest", "1.0", "v1.0.0"])
      expect(f({ ...PROFILE_OK, semconvVersion })).toEqual(
        one("logprofile.semconv_version_unpinned", "semconvVersion"),
      );
    const { body: _body, ...noBody } = PROFILE_OK.fieldMap;
    expect(f({ ...PROFILE_OK, fieldMap: noBody })).toEqual(
      one("logprofile.field_map_incomplete", "body"),
    );
    expect(f({ ...PROFILE_OK, fieldMap: { ...PROFILE_OK.fieldMap, severity: "" } })).toEqual(
      one("logprofile.field_map_incomplete", "severity"),
    );
    expect(f({ ...PROFILE_OK, mask: " " })).toEqual(one("logprofile.mask_blank", "mask"));
  });

  it.fails("CANDIDATE-U-OPSCTL-025 ログ record の必須 field と severity", () => {
    const f = (r: Record<string, unknown>) => pick(checkLogRecord(r, PROFILE_OK));
    expect(f(BASE_LOG)).toEqual([]);
    const { msg: _msg, ...noMsg } = BASE_LOG;
    expect(f(noMsg)).toEqual(one("log.field_missing", "body"));
    expect(f({ ...BASE_LOG, service: "" })).toEqual(one("log.field_missing", "service.name"));
    expect(f({ ...BASE_LOG, time: null })).toEqual(one("log.field_missing", "timestamp"));
    expect(f({ ...BASE_LOG, level: "verbose" })).toEqual(one("log.severity_invalid", "severity"));
    expect(f({ ...BASE_LOG, level: "FATAL" })).toEqual(one("log.severity_invalid", "severity"));
    expect(f({})).toEqual(
      ["timestamp", "severity", "body", "service.name"].map((s) => ({
        rule: "log.field_missing",
        subject: s,
      })),
    );
  });

  it.fails("CANDIDATE-U-OPSCTL-026 PII のマスク (入れ子・配列・大文字小文字)", () => {
    const f = (r: Record<string, unknown>) => pick(checkLogRecord(r, PROFILE_OK));
    const pii = (subject: string) => one("log.pii_unmasked", subject);
    expect(f({ ...BASE_LOG, email: "[MASKED]" })).toEqual([]);
    expect(f({ ...BASE_LOG, email: "a@b.test" })).toEqual(pii("email"));
    expect(f({ ...BASE_LOG, user: { Email: "a@b.test", name: "n" } })).toEqual(pii("user.Email"));
    const items = { ...BASE_LOG, items: [{ phone: "090" }, { phone: "[MASKED]" }] };
    const before = JSON.stringify(items);
    expect(f(items)).toEqual(pii("items[0].phone"));
    expect(JSON.stringify(items)).toBe(before);
    expect(f({ ...BASE_LOG, msg: "email=a@b.test" })).toEqual([]);
    expect(f({ ...BASE_LOG, PHONE: "090" })).toEqual(pii("PHONE"));
    expect(f({ ...BASE_LOG, email: "a", phone: "b" })).toEqual([...pii("email"), ...pii("phone")]);
  });

  it.fails("CANDIDATE-U-OPSCTL-027 migration の lint", () => {
    const f = (text: string) => lintMigration({ path: "m.sql", text });
    const at = (rule: string, line: number, column: number) => ({ rule, line, column });
    const D = "migration.destructive";
    expect(f("DROP TABLE users;")).toEqual([at(D, 1, 1)]);
    expect(f("alter table t drop column c;")).toEqual([at(D, 1, 15)]);
    expect(f("TRUNCATE t;")).toEqual([at(D, 1, 1)]);
    expect(f("DELETE FROM t;")).toEqual([at("migration.delete_without_where", 1, 1)]);
    expect(f("DELETE FROM t WHERE id = 1;")).toEqual([]);
    expect(f("-- DROP TABLE x;\nSELECT 1;")).toEqual([]);
    expect(f("/* TRUNCATE t; */ SELECT 1;")).toEqual([]);
    expect(f("-- ut-tdd:allow-destructive: 旧テーブルの退役 ADR-9\nDROP TABLE old;")).toEqual([]);
    expect(f("-- ut-tdd:allow-destructive:   \nDROP TABLE old;")).toEqual([
      at("migration.allow_reason_missing", 1, 1),
      at(D, 2, 1),
    ]);
    expect(f("DROP TABLE old; -- ut-tdd:allow-destructive: ok")).toEqual([]);
    expect(f("-- ut-tdd:allow-destructive: ok\n\nDROP TABLE old;")).toEqual([]);
    expect(f("-- ut-tdd:allow-destructive: ok\nSELECT 1;\nDROP TABLE old;")).toEqual([at(D, 3, 1)]);
  });

  it.fails("CANDIDATE-U-OPSCTL-028 段と baseline から severity を決める", () => {
    const sev = (stage: Stage, inBaseline: boolean) =>
      resolveControlSeverity({ stage, inBaseline });
    for (const inBaseline of [true, false]) {
      expect(sev("baseline", inBaseline)).toBe("advisory");
      expect(sev("advisory", inBaseline)).toBe("advisory");
      expect(sev("enforce", inBaseline)).toBe("error");
    }
    expect(sev("ratchet", true)).toBe("advisory");
    expect(sev("ratchet", false)).toBe("error");
  });

  it.fails("CANDIDATE-U-OPSCTL-029 高影響境界と、2 本の preset の同時の机上検証", () => {
    for (const kind of [
      "consumer-infra-apply",
      "cloud-region-iac-choice",
      "org-account-control",
      "pack-third-party-distribution",
      "paid-external-api",
    ])
      expect(requiresPoApproval(kind)).toBe(true);
    for (const kind of ["docs-edit", "preset-record-update", "", "Org-Account-Control"])
      expect(requiresPoApproval(kind)).toBe(false);
    expect(checkControlSet(CONTROLS_4)).toEqual([]);
    expect(checkPresetMapping(CONTROLS_4, PRESET_A)).toEqual([]);
    expect(checkPresetMapping(CONTROLS_4, PRESET_B)).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-030 proof の欠落・未知の値", () => {
    const f = (r: Rec) => pick(validateControlRecord(r));
    const invalid = one("control.proof_invalid", "proof");
    for (const proof of ["Runtime", "runtime ", "", "dynamic"])
      expect(f(ctl(CTRL_SEC, { proof }))).toEqual(invalid);
    expect(f(without(CTRL_SEC, "proof"))).toEqual(invalid);
    expect(
      f({ ...without(CTRL_LOG2, "proof"), evidence: { ...CTRL_LOG2.evidence, bindsTo: ["head"] } }),
    ).toEqual(invalid);
    expect(f(ctl(CTRL_LOG2, { proof: "static" }))).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-031 scope の未知の値と空の写像", () => {
    const f = (p: Preset) => pick(checkPresetMapping(CONTROLS_4, p));
    const invalid = one("preset.scope_invalid", `${ID_SEC}:secret-scanner`);
    expect(f(entry0(PRESET_A, ID_SEC, { scope: "Runtime" }))).toEqual(invalid);
    expect(f(entry0(PRESET_A, ID_SEC, { scope: undefined }))).toEqual(invalid);
    expect(f(entry0(PRESET_A, ID_SEC, { scope: "cron" }))).toEqual(invalid);
    expect(f(withMap(PRESET_A, { [ID_DB]: [] }))).toEqual(one("preset.mapping_empty", ID_DB));
    expect(f(withMap(PRESET_A, { [ID_DB]: { na: "別の方法で満たす" } }))).toEqual([]);
  });

  it.fails("CANDIDATE-U-OPSCTL-032 許可の印は後ろの SQL にだけ効く", () => {
    const f = (text: string) => lintMigration({ path: "m.sql", text });
    const D = { rule: "migration.destructive", line: 1, column: 1 };
    expect(f("DROP TABLE old;\n-- ut-tdd:allow-destructive: ok")).toEqual([D]);
    expect(f("-- ut-tdd:allow-destructive: ok\nDROP TABLE old;")).toEqual([]);
    expect(f("DROP TABLE old;\n\n-- ut-tdd:allow-destructive: ok")).toEqual([D]);
  });
});
