import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_REQUIRED } from "../src/lint/codex-hook-adapter-policy.ts";

const repoRoot = process.cwd();

/** コメント記号・改行・backtick を畳み、。と文末の . で文に分ける。 */
function splitSentences(text: string): string[] {
  const flat = text
    .replace(/^\s*(\/\*\*?|\*\/?)\s?/gm, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ");
  return flat
    .split(/(?<=。)|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NEGATES_FIELD =
  /非対応|未対応|利用できない|使えない|使用できない|拒否|reject|unsupported|not supported|not available|cannot be used|can't be used|does not (?:have|support|accept)|ignored|無視|持たない/i;
const FAIL_CLOSE = /fail-?close|fails? closed|止ま|阻止|block/i;
const LIMITER = /だけ|のみ|限る|限られ|限り|\bonly\b|solely|exclusively|limited to/i;
const LIMITER_NEGATED =
  /だけでなく|のみならず|だけでは|のみでは|限らない|限られない|not only|but also|not limited|more than/i;
const CONFIRMED_DENY = /確定 ?deny|confirmed deny|explicit deny/i;
const UNMEASURED = /未実測|unmeasured|not (?:yet )?measured/i;
const UNMEASURED_NEGATED = /未実測(?:ではない|でない)|(?:is|are) measured|必ず|always|guarantee/i;
const FAILURES = [
  /起動失敗|launch failure|startup failure|fails? to (?:start|launch)/i,
  /timeout|タイムアウト/i,
  /exit 1|exit code 1/i,
  /不正出力|不正 ?JSON|invalid output|malformed|invalid JSON/i,
];

/** (a) blockOnFailure が出る文はすべて、その field 自体が非対応・利用できないと述べている。 */
function fieldClaimOk(text: string): boolean {
  return splitSentences(text)
    .filter((s) => s.includes("blockOnFailure"))
    .every((s) => NEGATES_FIELD.test(s) && !/\bwith blockOnFailure\b/i.test(s));
}

/** (b) fail-close が確定 deny の場合に限られると、1 文の中で述べている。 */
function denyScopeOk(text: string): boolean {
  return splitSentences(text).some(
    (s) =>
      CONFIRMED_DENY.test(s) && FAIL_CLOSE.test(s) && LIMITER.test(s) && !LIMITER_NEGATED.test(s),
  );
}

/** (c) 4 つの障害を列挙した同じ文が「未実測」と述べている。 */
function unmeasuredOk(text: string): boolean {
  return splitSentences(text).some(
    (s) => FAILURES.every((re) => re.test(s)) && UNMEASURED.test(s) && !UNMEASURED_NEGATED.test(s),
  );
}

function codexFailureClaimsOk(text: string): boolean {
  return fieldClaimOk(text) && denyScopeOk(text) && unmeasuredOk(text);
}

function agentsCodexHookSection(): string {
  const text = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  const start = text.indexOf("Codex enforces the same guardrails");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

function lintHeaderComment(): string {
  const text = readFileSync(join(repoRoot, "src", "lint", "codex-hook-adapter.ts"), "utf8");
  const end = text.indexOf("*/");
  expect(end).toBeGreaterThan(0);
  return text.slice(0, end);
}

const GOOD_JA =
  "Codex enforces the same guardrails. blockOnFailure は利用できない。fail-close は guard が確定 deny を返した場合だけである。起動失敗・timeout・exit 1・不正出力は未実測 (fail-open の可能性あり)。";
const GOOD_EN =
  "Codex enforces the same guardrails. blockOnFailure is not supported. Fail-close holds only when a guard returns a confirmed deny. Launch failure, timeout, exit 1 and invalid output are unmeasured (fail-open is possible).";
const LOOSE_FLAG1 =
  "Codex enforces the same guardrails with blockOnFailure. 未対応 field は拒否する。確定 deny のときだけでなく、起動失敗・timeout・exit 1・不正出力でも必ず fail-close する。別件の性能は未実測。";

describe("Codex hook failure claims judge (pure function contrast)", () => {
  it("accepts the contract-shaped Japanese and English statements", () => {
    expect(codexFailureClaimsOk(GOOD_JA)).toBe(true);
    expect(codexFailureClaimsOk(GOOD_EN)).toBe(true);
  });
  it("rejects a text that says guards fail-close beyond a confirmed deny", () => {
    expect(codexFailureClaimsOk(LOOSE_FLAG1)).toBe(false);
    expect(denyScopeOk(LOOSE_FLAG1)).toBe(false);
    expect(unmeasuredOk(LOOSE_FLAG1)).toBe(false);
    expect(fieldClaimOk(LOOSE_FLAG1)).toBe(false);
  });
  it("(a) rejects blockOnFailure listed as a capability or used", () => {
    expect(fieldClaimOk("Codex hook (blockOnFailure, permissionDecision: deny) を持つ。")).toBe(
      false,
    );
    expect(fieldClaimOk("Guards run with blockOnFailure enabled.")).toBe(false);
    expect(fieldClaimOk("blockOnFailure は利用できる。")).toBe(false);
  });
  it("(a) accepts a text without blockOnFailure and a rejection naming it", () => {
    expect(fieldClaimOk("No such field is mentioned here.")).toBe(true);
    expect(fieldClaimOk("blockOnFailure is rejected as unsupported_hook_field.")).toBe(true);
    expect(fieldClaimOk("blockOnFailure は Codex では未対応で、無視される。")).toBe(true);
  });
  it("(a) ignores a negation word that sits in a different sentence", () => {
    expect(fieldClaimOk("Guards use blockOnFailure. 別の field は未対応である。")).toBe(false);
  });
  it("(b) requires the limiter to attach to the confirmed deny sentence", () => {
    expect(denyScopeOk("fail-close は確定 deny のみ。")).toBe(true);
    expect(denyScopeOk("Guards fail closed only on a confirmed deny.")).toBe(true);
    expect(denyScopeOk("fail-close は確定 deny を返した場合に成立する。限定は書かない。")).toBe(
      false,
    );
    expect(denyScopeOk("確定 deny のみならず fail-close する。")).toBe(false);
    expect(denyScopeOk("Guards fail closed not only on a confirmed deny.")).toBe(false);
    expect(denyScopeOk("確定 deny だけに限らない。fail-close は広い。")).toBe(false);
    expect(denyScopeOk("別件は deny だけ。fail-close は広い。")).toBe(false);
  });
  it("(c) requires all four failures and the unmeasured word in one sentence", () => {
    expect(unmeasuredOk("起動失敗・timeout・exit 1・不正出力は未実測。")).toBe(true);
    expect(unmeasuredOk("起動失敗・timeout・exit 1 は未実測。不正出力は別途。")).toBe(false);
    expect(unmeasuredOk("起動失敗・timeout・exit 1・不正出力は未実測ではない。")).toBe(false);
    expect(unmeasuredOk("起動失敗・timeout・exit 1・不正出力でも必ず止まる。未実測。")).toBe(false);
    expect(
      unmeasuredOk("Launch failure, timeout, exit 1 and malformed output are not measured."),
    ).toBe(true);
  });
});

describe("U-HOOKEXEC-015/016: Codex hook failure policy (Issue #1538)", () => {
  // Red: CODEX_REQUIRED の guard entry が blockOnFailure: true を持つため、assertion の不一致で赤になる。
  it.fails("U-HOOKEXEC-015: CODEX_REQUIRED has no blockOnFailure property", () => {
    const ids = CODEX_REQUIRED.map((entry) => entry.id);
    // 検査を空で通す実装 (guard entry ごと消す) を拒否する。
    expect(ids).toContain("agent-guard");
    expect(ids).toContain("work-guard");
    for (const entry of CODEX_REQUIRED) {
      expect(Object.hasOwn(entry, "blockOnFailure"), `${entry.id} carries blockOnFailure`).toBe(
        false,
      );
    }
  });

  // Red: AGENTS.md の節と lint 冒頭注釈の両方が (a)(b)(c) を満たさないため、assertion の不一致で赤になる。
  it.fails("U-HOOKEXEC-016: AGENTS.md and the lint header scope Codex guard fail-close to a confirmed deny", () => {
    const sources = [
      { label: "AGENTS.md", text: agentsCodexHookSection() },
      { label: "src/lint/codex-hook-adapter.ts", text: lintHeaderComment() },
    ];
    for (const { label, text } of sources) {
      expect(fieldClaimOk(text), `${label}: (a) blockOnFailure claim`).toBe(true);
      expect(denyScopeOk(text), `${label}: (b) fail-close limited to a confirmed deny`).toBe(true);
      expect(unmeasuredOk(text), `${label}: (c) four failures unmeasured`).toBe(true);
    }
  });
});
