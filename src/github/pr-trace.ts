// PLAN-L7-451 W4: typed PR trace contract (`<!-- ut-tdd:trace/v1 ... -->`)。
//
// PR body に人間可読要約と並置する機械可読 block の生成 (render) と検証 (validate)。
// 項目語彙は PLAN-L6-85 の PR body 規定 (plan / route / subject HEAD / base / episode /
// issue / receipt digest) を正とし、ここで拡張しない。block は手入力ではなく
// `ut-tdd github pr render` から生成する。validate は欠落・破損を fail-close する。

export const PR_TRACE_MARKER = "ut-tdd:trace/v1";

export interface PrTraceFields {
  plan_id: string;
  route_mode: string;
  subject_head: string;
  base_sha: string;
  issue_number: string;
  plan_revision?: string;
  episode_id?: string;
  admission_receipt_digest?: string;
  review_receipt_digest?: string;
}

const REQUIRED_KEYS = [
  "plan_id",
  "route_mode",
  "subject_head",
  "base_sha",
  "issue_number",
] as const;
const OPTIONAL_KEYS = [
  "plan_revision",
  "episode_id",
  "admission_receipt_digest",
  "review_receipt_digest",
] as const;
const KNOWN_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

const PLAN_ID_PATTERN = /^PLAN-[A-Z0-9]+-[0-9A-Za-z][0-9A-Za-z-]*$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export interface PrTraceFinding {
  code: string;
  message: string;
}

export interface PrTraceValidation {
  ok: boolean;
  fields: Partial<PrTraceFields>;
  findings: PrTraceFinding[];
}

/** trace block を生成する。必須項目の欠落・不正はここでも fail する (壊れた block を作らない)。 */
export function renderPrTraceBlock(fields: PrTraceFields): string {
  const validation = validateFields(fields);
  if (validation.length > 0) {
    throw new Error(`pr trace render rejected: ${validation.map((f) => f.code).join(", ")}`);
  }
  const lines: string[] = [`<!-- ${PR_TRACE_MARKER}`];
  for (const key of [...REQUIRED_KEYS, ...OPTIONAL_KEYS]) {
    const value = fields[key];
    if (value !== undefined && value !== "") lines.push(`${key}: ${value}`);
  }
  lines.push("-->");
  return lines.join("\n");
}

function validateFields(fields: Partial<PrTraceFields>): PrTraceFinding[] {
  const findings: PrTraceFinding[] = [];
  for (const key of REQUIRED_KEYS) {
    if (!fields[key]) {
      findings.push({ code: `missing-${key.replace(/_/g, "-")}`, message: `${key} が無い` });
    }
  }
  if (fields.plan_id && !PLAN_ID_PATTERN.test(fields.plan_id)) {
    findings.push({
      code: "invalid-plan-id",
      message: `plan_id が PLAN-* 形式でない: ${fields.plan_id}`,
    });
  }
  for (const key of ["subject_head", "base_sha"] as const) {
    const value = fields[key];
    if (value && !SHA_PATTERN.test(value)) {
      findings.push({
        code: `invalid-${key.replace(/_/g, "-")}`,
        message: `${key} が git SHA 形式でない: ${value}`,
      });
    }
  }
  if (fields.issue_number && !/^[0-9]+$/.test(fields.issue_number)) {
    findings.push({
      code: "invalid-issue-number",
      message: `issue_number が数値でない: ${fields.issue_number}`,
    });
  }
  return findings;
}

/** PR body から trace block を取り出して検証する。block 欠落・重複・未知キー・必須欠落は fail。 */
export function validatePrTraceBody(body: string): PrTraceValidation {
  const findings: PrTraceFinding[] = [];
  const blockPattern = new RegExp(
    `<!--\\s*${PR_TRACE_MARKER.replace(/[/.]/g, "\\$&")}\\n([\\s\\S]*?)-->`,
    "g",
  );
  const matches = [...body.matchAll(blockPattern)];
  if (matches.length === 0) {
    return {
      ok: false,
      fields: {},
      findings: [
        {
          code: "trace-block-missing",
          message: `PR body に <!-- ${PR_TRACE_MARKER} --> block が無い (ut-tdd github pr render で生成する)`,
        },
      ],
    };
  }
  if (matches.length > 1) {
    findings.push({ code: "trace-block-duplicated", message: "trace block が複数ある" });
  }
  const fields: Partial<PrTraceFields> = {};
  const blockBody = matches[0]?.[1] ?? "";
  for (const rawLine of blockBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 1) {
      findings.push({ code: "trace-line-malformed", message: `key: value 形式でない行: ${line}` });
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!KNOWN_KEYS.has(key)) {
      findings.push({
        code: "trace-key-unknown",
        message: `PLAN-L6-85 語彙に無いキー: ${key} (契約拡張は PLAN/ADR 経由)`,
      });
      continue;
    }
    if (key in fields) {
      findings.push({ code: "trace-key-duplicated", message: `キー重複: ${key}` });
      continue;
    }
    (fields as Record<string, string>)[key] = value;
  }
  findings.push(...validateFields(fields));
  return { ok: findings.length === 0, fields, findings };
}
