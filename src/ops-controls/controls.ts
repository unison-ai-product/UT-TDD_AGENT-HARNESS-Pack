/**
 * consumer 向け本番運用の統制 (issue #1725) の契約形 stub。
 * 契約: docs/design/harness/L6-function-design/consumer-operations-controls.md §10。
 *
 * Red 段の stub であり、判定は実装しない。`Finding[]` を返す関数は、空配列が「検査を通った」を意味して
 * 成功を期待する oracle を偶然通すので、throw する (設計保護 gate §10.3 手順 1'、テスト設計 §1)。
 * スカラーを返す関数は、成功側と失敗側の両方を期待する oracle が混ざるので、定数でも Red になる。
 * Green の PR で実装に置き換える。
 */

export type Domain =
  | "log-observability"
  | "infra-iac"
  | "operations"
  | "test-evidence"
  | "database"
  | "security"
  | "code-quality"
  | "api-release"
  | "data-platform"
  | "docs-adr"
  | "product-analytics";
export type Stage = "baseline" | "advisory" | "ratchet" | "enforce";
export type Layer = "L4" | "L5" | "L6" | "L7" | "L8" | "L9" | "L10" | "L11" | "L12" | "L13" | "L14";
export type Lifecycle =
  | "available"
  | "new-signups-stopped"
  | "end-of-support-scheduled"
  | "license-changed";
export interface Finding {
  rule: string;
  subject: string;
  message: string;
}
export interface MigrationFinding {
  rule: string;
  line: number;
  column: number;
}
export interface ControlRecord {
  id: string;
  domain: Domain;
  outcome: string;
  tier: { nfrItem: string; minLevel: number };
  layers: Layer[];
  appliesTo: ("server" | "client")[];
  proof: "static" | "runtime";
  evidence: {
    format: "json-result" | "sarif" | "junit-xml";
    schemaRef: string;
    bindsTo: ("head" | "deploy-receipt")[];
  };
  stage: Stage;
}
export interface ToolEntry {
  id: string;
  checkedAt: string;
  lifecycle: Lifecycle;
  verification: "confirmed" | "pending-primary";
  sourceUrl: string | null;
  license: {
    distribution: "reference-only" | "vendored";
    approval: "none" | "approved";
    recordRef?: string;
  };
}
export interface LogProfile {
  semconvVersion: string;
  fieldMap: Record<"timestamp" | "severity" | "body" | "service.name", string>;
  piiKeys: readonly string[];
  mask: string;
}
export interface Preset {
  id: string;
  target: "server" | "client";
  tools: ToolEntry[];
  controlMap: Record<
    string,
    { tool: string; ruleId: string; scope: "ci" | "runtime" | "manual-review" }[] | { na: string }
  >;
  logProfile?: LogProfile;
}

const notImplemented = (name: string): never => {
  throw new Error(`ops-controls.${name}: not implemented (Red stub, #1725)`);
};

export function validateControlRecord(_record: unknown): Finding[] {
  return notImplemented("validateControlRecord");
}
export function checkControlSet(_records: readonly ControlRecord[]): Finding[] {
  return notImplemented("checkControlSet");
}
export function validateToolEntry(_tool: ToolEntry, _today: string): Finding[] {
  return notImplemented("validateToolEntry");
}
export function isToolAdoptable(_tool: ToolEntry): boolean {
  return false;
}
export function isToolDistributable(_tool: ToolEntry): boolean {
  return false;
}
export function checkToolStaleness(
  _tool: ToolEntry,
  _today: string,
  _maxAgeDays: number,
): Finding[] {
  return notImplemented("checkToolStaleness");
}
export function checkPresetMapping(
  _controls: readonly ControlRecord[],
  _preset: Preset,
): Finding[] {
  return notImplemented("checkPresetMapping");
}
export function checkLogProfile(_profile: LogProfile): Finding[] {
  return notImplemented("checkLogProfile");
}
export function checkLogRecord(_record: Record<string, unknown>, _profile: LogProfile): Finding[] {
  return notImplemented("checkLogRecord");
}
export function lintMigration(_file: { path: string; text: string }): MigrationFinding[] {
  return notImplemented("lintMigration");
}
export function resolveControlSeverity(_input: {
  stage: Stage;
  inBaseline: boolean;
}): "advisory" | "error" {
  return "advisory";
}
export function requiresPoApproval(_kind: string): boolean {
  return false;
}
