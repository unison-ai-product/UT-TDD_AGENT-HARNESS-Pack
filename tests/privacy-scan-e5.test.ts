import { describe, expect, it } from "vitest";
import {
  analyzePrivacyScan,
  type PrivacyScanInput,
  type PrivacyUnit,
} from "../src/lint/privacy-scan.ts";

// L7 §2: no source line may match the email shape, so every address is joined at runtime.
const at = "@";
const mail = (local: string, domain: string) => [local, domain].join(at);
const G = mail("support", "github.com");
const GU = mail("Support", "GitHub.com");
const COMMIT = "a".repeat(40);
const ID = COMMIT.slice(0, 12);

const meta = (field: PrivacyUnit["field"], texts: readonly string[]): PrivacyUnit => ({
  source: "commit-meta",
  path: null,
  commit: COMMIT,
  field,
  lines: texts.map((text, index) => ({ line: index + 1, text })),
});
const input = (
  units: PrivacyUnit[],
  mode: PrivacyScanInput["mode"] = "diff",
): PrivacyScanInput => ({
  mode,
  units,
  skipped: 0,
  denylist: null,
  baseline: mode === "tree" ? [] : null,
  baselineUnreadable: false,
  previousBaseline: mode === "tree" ? { kind: "found", baseline: [] } : null,
});
const rows = (units: PrivacyUnit[], mode: PrivacyScanInput["mode"] = "diff") =>
  analyzePrivacyScan(input(units, mode)).findings.map((f) =>
    [f.location, f.line, f.kind].join(":"),
  );
const message = (...texts: string[]) => meta("message", texts);
const signed = (address: string, who = "dependabot[bot]", key = "Signed-off-by") =>
  `${key}: ${who} <${address}>`;

const ok = (units: PrivacyUnit[]) => {
  const result = analyzePrivacyScan(input(units));
  expect(result.findings).toEqual([]);
  expect(result.ok).toBe(true);
};

describe("privacy scan E5 (L6 §3, issue #1754)", () => {
  // Red: E5 is not implemented yet, so each allowed form still hits on main. One case per test.
  it("CANDIDATE-U-PRIVSCAN-019(a): lets the Dependabot trailer line through", () => {
    ok([message("subject", "", signed(G))]);
  });
  it("CANDIDATE-U-PRIVSCAN-019(b): ignores the case of the signed-off-by key", () => {
    ok([message("subject", "", signed(G, undefined, "signed-off-by"))]);
  });
  it("CANDIDATE-U-PRIVSCAN-019(d): handles blank lines, body lines and CRLF", () => {
    ok([message("subject\r", "\r", "body line\r", `${signed(G)}\r`, "\r", "tail\r")]);
  });
  // (c) is already excluded by E2 on main: a regression guard, green on HEAD.
  it("CANDIDATE-U-PRIVSCAN-019(c): keeps the bot noreply address out of the hits", () => {
    ok([message("subject", "", signed(`49699333+dependabot[bot]${at}users.noreply.github.com`))]);
  });

  // Guard oracle: green on HEAD (current code already hits every counterexample) and must stay so.
  const hit = (line: number) => `commit:${ID}:message:${line}:privacy-email-hit`;
  const counterexamples: [string, string][] = [
    ["a: text before the key", `see ${signed(G)}`],
    ["b: text after the address", `${signed(G)} extra`],
    ["c: non-reserved domain", signed(mail("support", "evil.jp"))],
    ["d: address prefix only", signed(`${G}.evil.jp`)],
    ["e1: other bot name", signed(G, "renovate[bot]")],
    ["e2: person name", signed(G, "Alice Example")],
    ["f: other key", signed(G, undefined, "Co-authored-by")],
    ["g: uppercase address", signed(GU)],
  ];
  for (const [name, text] of counterexamples) {
    it(`CANDIDATE-U-PRIVSCAN-020(${name}): still hits in a message line`, () => {
      expect(rows([message("subject", "", text)])).toEqual([hit(3)]);
    });
  }
  const line = signed(G);
  it("CANDIDATE-U-PRIVSCAN-020(h1): still hits in the author meta", () => {
    expect(rows([meta("author", [line])])).toEqual([`commit:${ID}:author:1:privacy-email-hit`]);
  });
  it("CANDIDATE-U-PRIVSCAN-020(h2): still hits in the committer meta", () => {
    expect(rows([meta("committer", [line])])).toEqual([
      `commit:${ID}:committer:1:privacy-email-hit`,
    ]);
  });
  const content = (source: "diff" | "tree"): PrivacyUnit => ({
    source,
    path: "docs/x.md",
    commit: source === "diff" ? COMMIT : null,
    field: "content",
    lines: [{ line: 1, text: line }],
  });
  it("CANDIDATE-U-PRIVSCAN-020(h3): still hits in a diff added line", () => {
    expect(rows([content("diff")])).toEqual([`docs/x.md@${ID}:1:privacy-email-hit`]);
  });
  it("CANDIDATE-U-PRIVSCAN-020(h4): still hits in tree content", () => {
    expect(rows([content("tree")], "tree")).toEqual(["docs/x.md:1:privacy-email-hit"]);
  });
});
