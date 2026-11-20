import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  analyzePrivacyScan,
  findEmailHitLines,
  type PrivacyBaseline,
  type PrivacyDenylistState,
  type PrivacyScanFinding,
  type PrivacyScanInput,
  type PrivacyScanResult,
  type PrivacyUnit,
  parsePrivacyBaseline,
  parsePrivacyDenylist,
  privacyScanMessages,
} from "../src/lint/privacy-scan.ts";

// L7 §2: no source line may match the email shape, so addresses are joined at runtime.
const at = "@";
const mail = (local: string, domain: string) => [local, domain].join(at);
const P = mail("alice", "mail-provider.jp");
// L7 §2: tests/ ship in the Pack, so the synthetic denylist word is joined at runtime too.
const D = ["example", "private", "repo"].join("-");
const COMMIT_A = "a".repeat(40);
const COMMIT_M = "c".repeat(40);

const lineUnit = (texts: readonly string[], overrides: Partial<PrivacyUnit> = {}): PrivacyUnit => ({
  source: "tree",
  path: "docs/x.md",
  commit: null,
  field: "content",
  lines: texts.map((text, index) => ({ line: index + 1, text })),
  ...overrides,
});
const pathUnit = (source: PrivacyUnit["source"], path: string, commit: string | null = null) =>
  lineUnit([path], { source, path, commit, field: "path", lines: [{ line: 0, text: path }] });
const treeFile = (path: string, texts: readonly string[]): PrivacyUnit[] => [
  lineUnit(texts, { path }),
  pathUnit("tree", path),
];
const packFile = (path: string, texts: readonly string[]): PrivacyUnit[] => [
  lineUnit(texts, { source: "pack", path }),
  pathUnit("pack", path),
];
const provided = (...entries: string[]): PrivacyDenylistState => ({
  kind: "provided",
  entries: entries.map((entry) => new RegExp(entry, "iu")),
});
const input = (overrides: Partial<PrivacyScanInput>): PrivacyScanInput => ({
  mode: "tree",
  units: [],
  skipped: 0,
  denylist: null,
  baseline: null,
  baselineUnreadable: false,
  previousBaseline: null,
  ...overrides,
});
const treeInput = (
  units: PrivacyUnit[],
  baseline: PrivacyBaseline = [],
  previous: PrivacyScanInput["previousBaseline"] = { kind: "found", baseline },
) => input({ mode: "tree", units, baseline, previousBaseline: previous });
const packInput = (units: PrivacyUnit[], denylist: PrivacyDenylistState = provided(D)) =>
  input({ mode: "pack", units, denylist });
const fmt = (finding: PrivacyScanFinding) =>
  [finding.location, finding.line, finding.kind, ...(finding.reason ? [finding.reason] : [])].join(
    ":",
  );
const rows = (result: PrivacyScanResult) => result.findings.map(fmt);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("privacy scan candidate oracles (pure functions)", () => {
  it("U-PRIVSCAN-001: reports 1-based email hit lines once per line", () => {
    expect(findEmailHitLines(lineUnit(["", P, `${P} and ${P}`]))).toEqual([2, 3]);
    expect(findEmailHitLines(lineUnit(["a\r", "b\r", `${P}\r`]))).toEqual([3]);
    // L6 §3: the local part may hold `.` and letters, so `x.` + P and `b` + P are whole addresses.
    expect(findEmailHitLines(lineUnit([`x.${P}`]))).toEqual([1]);
    expect(findEmailHitLines(lineUnit([`b${P}`]))).toEqual([1]);
    expect(findEmailHitLines(lineUnit([`${P}-x`]))).toEqual([]);
    expect(findEmailHitLines(lineUnit([`<${P}>`]))).toEqual([1]);
    expect(findEmailHitLines(lineUnit(["@types/node", "react@18.3.1", "@"]))).toEqual([]);
  });

  it("U-PRIVSCAN-002: decides exclusions per matched address, not per line", () => {
    const excluded = [
      mail("alice", "example.com"),
      mail("bob", "mail.example.org"),
      mail("c", "example.net"),
      mail("d", "host.test"),
      mail("e", "host.invalid"),
      mail("f", "host.localhost"),
      mail("noreply", "anthropic.com"),
      mail("NoReply", "github.com"),
      mail("no-reply", "service.jp"),
      mail("12345+alice", "users.noreply.github.com"),
      `${mail("git", "github.com")}:example-org/private-repo.git`,
      `Co-Authored-By: Claude <${mail("noreply", "anthropic.com")}>`,
    ];
    expect(findEmailHitLines(lineUnit(excluded))).toEqual([]);
    const hits = [
      mail("x", "example.com.evil.jp"),
      mail("x", "notexample.com"),
      mail("noreplyx", "service.jp"),
      `${mail("git", "github.com")} next`,
      `Co-Authored-By: X <${P}>`,
      `example dummy ${P}`,
    ];
    expect(findEmailHitLines(lineUnit(hits))).toEqual([1, 2, 3, 4, 5, 6]);
    for (const path of ["package-lock.json", "sub/package-lock.json"]) {
      expect(findEmailHitLines(lineUnit([P], { path }))).toEqual([]);
    }
  });

  it("U-PRIVSCAN-003: parses the denylist without leaking entries", () => {
    expect(parsePrivacyDenylist("")).toEqual({ kind: "empty" });
    expect(parsePrivacyDenylist("  \n\t\n")).toEqual({ kind: "empty" });
    expect(parsePrivacyDenylist("# only\n#comment\n")).toEqual({ kind: "empty" });
    const parsed = parsePrivacyDenylist(`# c\r\n\r\n${D}\r\nAlice\\s+Example\r\n`);
    expect(parsed.kind).toBe("provided");
    if (parsed.kind !== "provided") return;
    expect(parsed.entries).toHaveLength(2);
    expect(
      parsed.entries.every((entry) => entry.flags.includes("i") && entry.flags.includes("u")),
    ).toBe(true);
    expect(parsed.entries.every((entry) => entry.flags.length === 2)).toBe(true);
    expect(parsePrivacyDenylist(`${D}\nvalid-two\n(\n`)).toEqual({
      kind: "invalid",
      entryLines: [3],
    });
    const invalid = parsePrivacyDenylist(`${D}\nbroken-one(\nvalid\nbroken-two[\n`);
    expect(invalid).toEqual({ kind: "invalid", entryLines: [2, 4] });
    expect(JSON.stringify(invalid)).not.toContain("broken-");
  });

  it("U-PRIVSCAN-004: applies the denylist to pack content and paths", () => {
    const content = packInput(packFile("docs/a.md", ["a", "b", "c", "d", `x ${D.toUpperCase()}`]));
    expect(rows(analyzePrivacyScan(content))).toEqual(["pack:docs/a.md:5:privacy-denylist-hit"]);
    const hitPath = `docs/${D}-notes.md`;
    const pathResult = analyzePrivacyScan(packInput(packFile(hitPath, ["harmless"])));
    expect(rows(pathResult)).toEqual([
      `pack:path-sha256:${sha256(hitPath)}:0:privacy-denylist-hit`,
    ]);
    const lock = analyzePrivacyScan(packInput(packFile("package-lock.json", ["{", D])));
    expect(rows(lock)).toEqual(["pack:package-lock.json:2:privacy-denylist-hit"]);
    const noreply = analyzePrivacyScan(
      packInput(packFile("docs/b.md", [mail(`12345+${D}`, "users.noreply.github.com")])),
    );
    expect(rows(noreply)).toEqual(["pack:docs/b.md:1:privacy-denylist-hit"]);
    const twice = analyzePrivacyScan(packInput(packFile("docs/c.md", [`${D} ${D}`])));
    expect(rows(twice)).toEqual(["pack:docs/c.md:1:privacy-denylist-hit"]);
  });

  it("U-PRIVSCAN-005: emits only the closed output vocabulary", () => {
    const hitPath = `docs/${D}/notes.md`;
    const units = [
      ...packFile("docs/a.md", [P, `${D} line`, `Co-Authored-By: X <${P}>`]),
      ...packFile(hitPath, [P]),
    ];
    const results = [
      analyzePrivacyScan(packInput(units)),
      // Without a provided denylist the scanner cannot judge path hits, so this run uses safe paths.
      analyzePrivacyScan(
        packInput(packFile("docs/a.md", [P, `${D} line`, `Co-Authored-By: X <${P}>`]), {
          kind: "invalid",
          entryLines: [2],
        }),
      ),
      analyzePrivacyScan(
        input({
          mode: "diff",
          units: [lineUnit([P], { source: "diff", path: "docs/a.md", commit: COMMIT_A })],
        }),
      ),
    ];
    const forbidden = [D, P, "mail-provider", "notes.md", "Co-Authored-By", `docs/${D}`];
    for (const result of results) {
      const messages = privacyScanMessages(result);
      expect(messages.length).toBeGreaterThan(1);
      for (const message of messages) {
        for (const value of forbidden) expect(message).not.toContain(value);
      }
      const tail = messages.at(-1) ?? "";
      for (const key of [
        "privacy-scan mode=",
        " checked=",
        " skipped=",
        " email=",
        " denylist=",
        " stale=",
        " baselined=",
        " baseline=",
      ]) {
        expect(tail).toContain(key);
      }
      for (const message of messages.slice(0, -1)) {
        expect(message).toMatch(/^[^\s]+:\d+:privacy-[a-z-]+(?::[a-z-]+)?$/);
      }
    }
    const pathRows = rows(results[0]).filter((row) => row.includes("path-sha256:"));
    expect(pathRows).toEqual([
      `pack:path-sha256:${sha256(hitPath)}:0:privacy-denylist-hit`,
      `pack:path-sha256:${sha256(hitPath)}:1:privacy-email-hit`,
    ]);
  });

  it("U-PRIVSCAN-006: requires a provided denylist only in pack mode", () => {
    const units = packFile("docs/a.md", [P]);
    const email = "pack:docs/a.md:1:privacy-email-hit";
    for (const reason of ["absent", "unreadable", "empty", "in-repo"] as const) {
      const result = analyzePrivacyScan(packInput(units, { kind: reason }));
      expect(result.ok).toBe(false);
      expect(rows(result)).toEqual([`denylist:0:privacy-denylist-unavailable:${reason}`, email]);
    }
    const invalid = analyzePrivacyScan(packInput(units, { kind: "invalid", entryLines: [2] }));
    expect(rows(invalid)).toEqual(["denylist:2:privacy-denylist-invalid", email]);
    expect(rows(analyzePrivacyScan(packInput(units)))).toEqual([email]);
    for (const mode of ["tree", "diff"] as const) {
      const source = mode === "tree" ? "tree" : "diff";
      const result = analyzePrivacyScan(
        input({
          mode,
          units: [lineUnit([P], { source, commit: mode === "diff" ? COMMIT_A : null })],
          baseline: mode === "tree" ? [] : null,
          previousBaseline: mode === "tree" ? { kind: "absent" } : null,
        }),
      );
      expect(result.findings.map((finding) => finding.kind)).toEqual(["privacy-email-hit"]);
      expect(privacyScanMessages(result).at(-1)).toContain("denylist=unused");
    }
  });

  it("U-PRIVSCAN-007: reports every added line per commit in diff mode", () => {
    const units = [
      lineUnit([], {
        source: "diff",
        path: "docs/a.md",
        commit: COMMIT_A,
        lines: [{ line: 7, text: P }],
      }),
      pathUnit("diff", "docs/a.md", COMMIT_A),
    ];
    const result = analyzePrivacyScan(input({ mode: "diff", units, baseline: ["docs/a.md"] }));
    expect(rows(result)).toEqual([`docs/a.md@${COMMIT_A.slice(0, 12)}:7:privacy-email-hit`]);
    expect(result.ok).toBe(false);
    const removedOnly = analyzePrivacyScan(
      input({
        mode: "diff",
        units: [lineUnit(["harmless"], { source: "diff", path: "docs/a.md", commit: COMMIT_M })],
      }),
    );
    expect(removedOnly.findings).toEqual([]);
  });

  it("U-PRIVSCAN-008: checks commit metadata including merge commits", () => {
    const meta = (field: PrivacyUnit["field"], texts: string[], commit = COMMIT_A) =>
      lineUnit(texts, { source: "commit-meta", path: null, commit, field });
    const id = COMMIT_A.slice(0, 12);
    const diff = (units: PrivacyUnit[]) => rows(analyzePrivacyScan(input({ mode: "diff", units })));
    expect(diff([meta("author", [P])])).toEqual([`commit:${id}:author:1:privacy-email-hit`]);
    expect(diff([meta("committer", [mail("noreply", "github.com")])])).toEqual([]);
    expect(diff([meta("message", ["subject", "", `body ${P}`])])).toEqual([
      `commit:${id}:message:3:privacy-email-hit`,
    ]);
    expect(
      diff([
        meta("message", ["s", "", `Co-Authored-By: Claude <${mail("noreply", "anthropic.com")}>`]),
      ]),
    ).toEqual([]);
    expect(diff([meta("author", [P], COMMIT_M)])).toEqual([
      `commit:${COMMIT_M.slice(0, 12)}:author:1:privacy-email-hit`,
    ]);
  });

  it("U-PRIVSCAN-009: lets the baseline excuse tree email hits only", () => {
    const baseline = ["docs/p.md"];
    const hit = treeFile("docs/p.md", [P, "x", P]);
    const allowed = analyzePrivacyScan(treeInput(hit, baseline));
    expect(allowed.findings).toEqual([]);
    expect(privacyScanMessages(allowed).at(-1)).toContain("baselined=2");
    const other = analyzePrivacyScan(
      treeInput([...hit, ...treeFile("docs/other.md", [P])], baseline),
    );
    expect(rows(other)).toEqual(["docs/other.md:1:privacy-email-hit"]);
    const missing = analyzePrivacyScan(treeInput(treeFile("docs/q.md", ["x"]), baseline));
    expect(rows(missing)).toEqual(["docs/p.md:0:privacy-stale-baseline:missing-file"]);
    const noHit = analyzePrivacyScan(treeInput(treeFile("docs/p.md", ["x"]), baseline));
    expect(rows(noHit)).toEqual(["docs/p.md:0:privacy-stale-baseline:no-hit"]);
    const pack = analyzePrivacyScan(
      input({ mode: "pack", units: packFile("docs/p.md", [P, "x", P]), denylist: provided(D) }),
    );
    expect(rows(pack)).toEqual([
      "pack:docs/p.md:1:privacy-email-hit",
      "pack:docs/p.md:3:privacy-email-hit",
    ]);
  });

  it("U-PRIVSCAN-010: only lets the baseline shrink against the merge-base", () => {
    const units = [...treeFile("docs/p.md", [P]), ...treeFile("docs/r.md", [P])];
    const current = ["docs/p.md", "docs/r.md"];
    const kinds = (result: PrivacyScanResult) => result.findings.map((finding) => finding.kind);
    const run = (previous: PrivacyScanInput["previousBaseline"], baselineUnreadable = false) =>
      analyzePrivacyScan({ ...treeInput(units, current, previous), baselineUnreadable });
    expect(kinds(run({ kind: "found", baseline: current }))).toEqual([]);
    expect(run({ kind: "found", baseline: current }).ok).toBe(true);
    expect(kinds(run({ kind: "found", baseline: [...current, "docs/s.md"] }))).not.toContain(
      "privacy-baseline-grown",
    );
    const grown = run({ kind: "found", baseline: ["docs/p.md"] });
    expect(kinds(grown)).toContain("privacy-baseline-grown");
    expect(grown.ok).toBe(false);
    expect(kinds(run({ kind: "absent" }))).not.toContain("privacy-baseline-grown");
    const base = run({ kind: "unreadable" });
    expect(kinds(base)).toContain("privacy-baseline-base-unreadable");
    expect(base.ok).toBe(false);
    const broken = run({ kind: "found", baseline: current }, true);
    expect(kinds(broken)).toContain("privacy-baseline-unreadable");
    expect(broken.ok).toBe(false);
  });

  it("U-PRIVSCAN-011: parses the baseline strictly", () => {
    expect(parsePrivacyBaseline('["docs/a.md","docs/b.md"]')).toEqual(["docs/a.md", "docs/b.md"]);
    expect(parsePrivacyBaseline("[]")).toEqual([]);
    expect(parsePrivacyBaseline("{}")).toBeNull();
    expect(parsePrivacyBaseline('["docs/a.md", 1]')).toBeNull();
    expect(parsePrivacyBaseline('["docs/a.md","docs/a.md"]')).toBeNull();
    expect(parsePrivacyBaseline('["docs/a.md"')).toBeNull();
  });

  it("U-PRIVSCAN-012: is deterministic and fails closed on empty input", () => {
    const emptyTree = analyzePrivacyScan(treeInput([]));
    expect(emptyTree.findings.map((finding) => finding.kind)).toContain("privacy-input-unreadable");
    expect(emptyTree.ok).toBe(false);
    const emptyPack = analyzePrivacyScan(packInput([]));
    expect(emptyPack.findings.map((finding) => finding.kind)).toContain("privacy-input-unreadable");
    expect(emptyPack.ok).toBe(false);
    const skipped = analyzePrivacyScan({
      ...treeInput(treeFile("docs/t.bin", [`${P}\u0000`])),
      skipped: 1,
    });
    expect(skipped.findings).toEqual([]);
    expect(privacyScanMessages(skipped).at(-1)).toContain("skipped=1");
    const units = [
      ...treeFile("docs/b.md", [P, "x", P]),
      ...treeFile("docs/a.md", [P]),
      ...treeFile("docs/c.md", ["y"]),
    ];
    const snapshot = JSON.stringify(units);
    const forward = analyzePrivacyScan(treeInput(units, ["docs/b.md", "docs/c.md"]));
    const reversed = analyzePrivacyScan(
      treeInput([...units].reverse(), ["docs/c.md", "docs/b.md"]),
    );
    expect(reversed.findings).toEqual(forward.findings);
    expect(reversed.summary).toEqual(forward.summary);
    expect(analyzePrivacyScan(treeInput(units, ["docs/b.md", "docs/c.md"]))).toEqual(forward);
    expect(JSON.stringify(units)).toBe(snapshot);
    expect(rows(forward)).toEqual([
      "docs/a.md:1:privacy-email-hit",
      "docs/c.md:0:privacy-stale-baseline:no-hit",
    ]);
  });
});
