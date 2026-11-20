// consumer 向け本番運用の統制 (#1725) の Red テストが共有する fixture。
// テスト設計 §2 (docs/test-design/harness/L7-consumer-operations-controls-test-design.md)。
import type {
  ControlRecord,
  LogProfile,
  Preset,
  ToolEntry,
} from "../../src/ops-controls/controls.ts";

export const TODAY = "2026-11-17";
export const ID_SEC = "OPS-SEC-001";
export const ID_DB = "OPS-DB-001";
export const ID_LOG1 = "OPS-LOG-001";
export const ID_LOG2 = "OPS-LOG-002";
export const ID_CRASH = "OPS-CRASH-001";
export const ID_UNKNOWN = "OPS-ZZZ-999";

export type Rec = Record<string, unknown>;
export const ctl = (base: ControlRecord, patch: Rec = {}): Rec => ({ ...base, ...patch });
export const without = (obj: object, key: string): Rec => {
  const copy: Rec = { ...obj };
  delete copy[key];
  return copy;
};
export const ev = (base: ControlRecord, patch: Rec): Rec =>
  ctl(base, { evidence: { ...base.evidence, ...patch } });
export const pick = (findings: { rule: string; subject: string }[]) =>
  findings.map(({ rule, subject }) => ({ rule, subject }));
export const one = (rule: string, subject: string) => [{ rule, subject }];

export const CTRL_SEC: ControlRecord = {
  id: ID_SEC,
  domain: "security",
  outcome: "secret が commit されない",
  tier: { nfrItem: "X-1", minLevel: 3 },
  layers: ["L4", "L7"],
  appliesTo: ["server", "client"],
  proof: "static",
  evidence: { format: "sarif", schemaRef: "s/sarif", bindsTo: ["head"] },
  stage: "advisory",
};
export const CTRL_DB: ControlRecord = {
  ...CTRL_SEC,
  id: ID_DB,
  domain: "database",
  appliesTo: ["server"],
  layers: ["L5", "L7"],
  evidence: { format: "json-result", schemaRef: "s/json", bindsTo: ["head"] },
};
export const CTRL_LOG1: ControlRecord = {
  ...CTRL_SEC,
  id: ID_LOG1,
  domain: "log-observability",
  appliesTo: ["server"],
  tier: { nfrItem: "X-1", minLevel: 2 },
  evidence: { format: "junit-xml", schemaRef: "s/junit", bindsTo: ["head"] },
};
export const CTRL_LOG2: ControlRecord = {
  ...CTRL_LOG1,
  id: ID_LOG2,
  proof: "runtime",
  layers: ["L13", "L14"],
  evidence: { format: "json-result", schemaRef: "s/json", bindsTo: ["head", "deploy-receipt"] },
  stage: "baseline",
};
export const CTRL_CRASH: ControlRecord = {
  ...CTRL_SEC,
  id: ID_CRASH,
  domain: "operations",
  appliesTo: ["client"],
};
export const CONTROLS_4 = [CTRL_SEC, CTRL_DB, CTRL_LOG1, CTRL_LOG2];

export const TOOL_OK: ToolEntry = {
  id: "t",
  checkedAt: "2026-11-01",
  lifecycle: "available",
  verification: "confirmed",
  sourceUrl: "https://example.test/doc",
  license: { distribution: "reference-only", approval: "approved", recordRef: "ADR-X" },
};
export const TOOL_PENDING: ToolEntry = {
  ...TOOL_OK,
  verification: "pending-primary",
  sourceUrl: null,
  license: { distribution: "reference-only", approval: "none" },
};
export const tool = (patch: Rec = {}): ToolEntry => ({ ...TOOL_OK, ...patch }) as ToolEntry;
export const lic = (patch: Rec) => tool({ license: { distribution: "reference-only", ...patch } });

export const PROFILE_OK: LogProfile = {
  semconvVersion: "1.0.0",
  fieldMap: { timestamp: "time", severity: "level", body: "msg", "service.name": "service" },
  piiKeys: ["email", "phone"],
  mask: "[MASKED]",
};
export const BASE_LOG = { time: "t", level: "info", msg: "m", service: "s" };

export type Entry = { tool: string; ruleId: string; scope?: string };
export const toolsOf = (ids: string[]): ToolEntry[] => ids.map((id) => ({ ...TOOL_OK, id }));
export const ci = (t: string, ruleId: string) => ({ tool: t, ruleId, scope: "ci" as const });
export const rt = (t: string, ruleId: string) => ({ tool: t, ruleId, scope: "runtime" as const });
export const PRESET_A: Preset = {
  id: "aws-cdk",
  target: "server",
  tools: toolsOf([
    "secret-scanner",
    "iac-lint",
    "migration-lint",
    "test-runner",
    "iac-assert",
    "observer",
  ]),
  controlMap: {
    [ID_SEC]: [ci("secret-scanner", "aws-access-token"), ci("iac-lint", "AwsSolutions-SMG4")],
    [ID_DB]: [ci("migration-lint", "ban-drop-column, ban-drop-table")],
    [ID_LOG1]: [ci("test-runner", "logger-output.required-fields, logger-output.pii-masked")],
    [ID_LOG2]: [
      ci("iac-assert", "log-group.retention-set"),
      rt("observer", "log-delivery.observed"),
    ],
  },
};
export const PRESET_B: Preset = {
  id: "vps-compose",
  target: "server",
  tools: toolsOf([
    "secret-scanner",
    "compose-lint",
    "migration-lint",
    "logger",
    "test-runner",
    "shipper-config-check",
    "observer",
  ]),
  controlMap: {
    [ID_SEC]: [
      ci("secret-scanner", "generic-api-key"),
      ci("compose-lint", "compose.no-inline-secret"),
    ],
    [ID_DB]: [ci("migration-lint", "ban-drop-column, ban-drop-table")],
    [ID_LOG1]: [
      ci("logger", "logger-output.required-fields"),
      ci("test-runner", "logger-output.pii-masked"),
    ],
    [ID_LOG2]: [
      ci("shipper-config-check", "fluent-bit.config-valid"),
      ci("test-runner", "log-retention.configured"),
      rt("observer", "log-delivery.observed"),
    ],
  },
};
export const withMap = (preset: Preset, patch: Record<string, unknown>): Preset =>
  ({ ...preset, controlMap: { ...preset.controlMap, ...patch } }) as Preset;
export const dropKey = (preset: Preset, key: string): Preset => {
  const controlMap = { ...preset.controlMap };
  delete controlMap[key];
  return { ...preset, controlMap };
};
export const entries = (preset: Preset, id: string): Entry[] => preset.controlMap[id] as Entry[];
export const entry0 = (preset: Preset, id: string, patch: Rec): Preset => {
  const list = entries(preset, id);
  return withMap(preset, { [id]: [{ ...list[0], ...patch }, ...list.slice(1)] });
};
export const withTool = (preset: Preset, id: string, patch: Rec): Preset => ({
  ...preset,
  tools: preset.tools.map((t) => (t.id === id ? ({ ...t, ...patch } as ToolEntry) : t)),
});
