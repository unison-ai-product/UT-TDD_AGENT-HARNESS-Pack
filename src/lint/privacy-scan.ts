/**
 * Privacy scan (issue #1391): pure judgement over already-loaded units.
 * Contract: docs/design/harness/L6-function-design/privacy-scan.md (§3 email shape and
 * exclusions, §4 denylist, §6 baseline, §7 findings, §8 closed output vocabulary).
 * No filesystem, git, or environment access lives here (see privacy-scan-inputs.ts).
 */
import { createHash } from "node:crypto";

export type PrivacyScanMode = "tree" | "diff" | "pack";

export interface PrivacyUnit {
  source: "tree" | "pack" | "diff" | "commit-meta";
  path: string | null;
  commit: string | null;
  field: "content" | "path" | "author" | "committer" | "message";
  lines: readonly { line: number; text: string }[];
}

export type PrivacyDenylist =
  | { kind: "empty" }
  | { kind: "provided"; entries: readonly RegExp[] }
  | { kind: "invalid"; entryLines: readonly number[] };

export type PrivacyDenylistState =
  | PrivacyDenylist
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "in-repo" };

export type PrivacyBaseline = readonly string[];

export type PreviousPrivacyBaseline =
  | { kind: "found"; baseline: PrivacyBaseline }
  | { kind: "absent" }
  | { kind: "unreadable" };

export interface PrivacyScanInput {
  mode: PrivacyScanMode;
  units: readonly PrivacyUnit[];
  skipped: number;
  denylist: PrivacyDenylistState | null;
  baseline: PrivacyBaseline | null;
  baselineUnreadable: boolean;
  previousBaseline: PreviousPrivacyBaseline | null;
}

export interface PrivacyScanFinding {
  location: string;
  line: number;
  kind: string;
  reason: string | null;
}

export interface PrivacyScanSummary {
  mode: PrivacyScanMode;
  checked: number;
  skipped: number;
  email: number;
  denylist: number | null;
  stale: number;
  baselined: number;
  baseline: number;
}

export interface PrivacyScanResult {
  ok: boolean;
  findings: PrivacyScanFinding[];
  summary: PrivacyScanSummary;
}

export const PRIVACY_SCAN_BASELINE_PATH = "docs/governance/privacy-scan-baseline.json";

/** L6 §3: local part, `@`, two or more labels with an alphabetic TLD, not inside a longer token. */
const EMAIL_PATTERN =
  /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
const RESERVED_DOMAIN = /(?:^|\.)example\.(?:com|net|org)$|\.(?:example|invalid|test|localhost)$/;

function isExcludedAddress(local: string, domain: string, next: string | undefined): boolean {
  const l = local.toLowerCase();
  const d = domain.toLowerCase();
  if (RESERVED_DOMAIN.test(d)) return true; // E1
  if (l === "noreply" || l === "no-reply" || d === "users.noreply.github.com") return true; // E2
  return l === "git" && next === ":"; // E3
}

/** L6 §3 E5: Dependabot's whole-line sign-off trailer (commit message only). */
const DEPENDABOT_SIGNOFF =
  /^(?:[Ss][Ii][Gg][Nn][Ee][Dd]-[Oo][Ff][Ff]-[Bb][Yy]):[ \t]+dependabot\[bot\][ \t]+<support@github\.com>[ \t]*$/;

function isPackageLock(path: string | null): boolean {
  return path !== null && path.replaceAll("\\", "/").split("/").at(-1) === "package-lock.json";
}

function lineHasEmail(text: string): boolean {
  if (!text.includes("@")) return false;
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const next = text[(match.index ?? 0) + match[0].length];
    if (!isExcludedAddress(match[1], match[2], next)) return true;
  }
  return false;
}

export function findEmailHitLines(unit: PrivacyUnit): number[] {
  if (unit.field === "content" && isPackageLock(unit.path)) return []; // E4
  const hits = new Set<number>();
  for (const { line, text } of unit.lines) {
    if (unit.field === "message" && DEPENDABOT_SIGNOFF.test(text.replace(/\r$/, ""))) continue; // E5
    if (lineHasEmail(text)) hits.add(line);
  }
  return [...hits].sort((a, b) => a - b);
}

export function parsePrivacyDenylist(text: string): PrivacyDenylist {
  const entries: RegExp[] = [];
  const entryLines: number[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const source = raw.trim();
    if (source === "" || source.startsWith("#")) continue;
    try {
      entries.push(new RegExp(source, "iu"));
    } catch {
      entryLines.push(index + 1); // never keep the exception message: it embeds the source
    }
  }
  if (entryLines.length > 0) return { kind: "invalid", entryLines };
  return entries.length === 0 ? { kind: "empty" } : { kind: "provided", entries };
}

export function parsePrivacyBaseline(sourceText: string): PrivacyBaseline | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((path) => typeof path === "string")) return null;
  return new Set(parsed).size === parsed.length ? (parsed as string[]) : null;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const commitId = (commit: string | null) => (commit ?? "").slice(0, 12);

interface Judge {
  entries: readonly RegExp[] | null;
  hitPaths: Set<string>;
}

function denylistHit(judge: Judge, text: string): boolean {
  return judge.entries?.some((entry) => entry.test(text)) ?? false;
}

function unitLocation(judge: Judge, unit: PrivacyUnit): string {
  if (unit.source === "commit-meta") return `commit:${commitId(unit.commit)}:${unit.field}`;
  const raw = unit.path ?? "";
  const path = judge.hitPaths.has(raw) ? `path-sha256:${sha256(raw)}` : raw;
  if (unit.source === "pack") return `pack:${path}`;
  if (unit.source === "diff") return `${path}@${commitId(unit.commit)}`;
  return path;
}

function denylistState(state: PrivacyDenylistState | null): {
  entries: readonly RegExp[] | null;
  findings: PrivacyScanFinding[];
} {
  if (state?.kind === "provided") return { entries: state.entries, findings: [] };
  if (state?.kind === "invalid") {
    const findings = state.entryLines.map((line) => ({
      location: "denylist",
      line,
      kind: "privacy-denylist-invalid",
      reason: null,
    }));
    return { entries: null, findings };
  }
  const reason = state?.kind ?? "absent";
  const unavailable = { location: "denylist", line: 0, kind: "privacy-denylist-unavailable" };
  return { entries: null, findings: [{ ...unavailable, reason }] };
}

function hasBinaryContent(unit: PrivacyUnit): boolean {
  return unit.field === "content" && unit.lines.some(({ text }) => text.includes("\u0000"));
}

interface HitCounts {
  findings: PrivacyScanFinding[];
  email: number;
  denylist: number;
  baselined: number;
  emailPaths: Set<string>;
}

function scanUnits(input: PrivacyScanInput, judge: Judge, excused: Set<string>): HitCounts {
  const counts: HitCounts = {
    findings: [],
    email: 0,
    denylist: 0,
    baselined: 0,
    emailPaths: new Set(),
  };
  for (const unit of input.units) {
    if (hasBinaryContent(unit)) continue;
    const location = unitLocation(judge, unit);
    const content = unit.field === "content" && unit.path !== null ? unit.path : null;
    const emailLines = new Set(findEmailHitLines(unit));
    for (const { line, text } of unit.lines) {
      if (emailLines.has(line)) {
        if (content !== null) counts.emailPaths.add(content);
        if (content !== null && excused.has(content)) counts.baselined += 1;
        else {
          counts.findings.push({ location, line, kind: "privacy-email-hit", reason: null });
          counts.email += 1;
        }
      }
      if (denylistHit(judge, text)) {
        counts.findings.push({ location, line, kind: "privacy-denylist-hit", reason: null });
        counts.denylist += 1;
      }
    }
  }
  return counts;
}

function baselineFindings(
  input: PrivacyScanInput,
  baseline: PrivacyBaseline,
  emailPaths: Set<string>,
): PrivacyScanFinding[] {
  const findings: PrivacyScanFinding[] = [];
  const add = (location: string, kind: string, reason: string | null = null) =>
    findings.push({ location, line: 0, kind, reason });
  if (input.baselineUnreadable) add(PRIVACY_SCAN_BASELINE_PATH, "privacy-baseline-unreadable");
  const contentPaths = new Set(
    input.units.filter((unit) => unit.field === "content").map((unit) => unit.path),
  );
  for (const path of baseline) {
    if (!contentPaths.has(path)) add(path, "privacy-stale-baseline", "missing-file");
    else if (!emailPaths.has(path)) add(path, "privacy-stale-baseline", "no-hit");
  }
  const previous = input.previousBaseline;
  if (previous?.kind === "unreadable")
    add(PRIVACY_SCAN_BASELINE_PATH, "privacy-baseline-base-unreadable");
  if (previous?.kind === "found") {
    const before = new Set(previous.baseline);
    for (const path of baseline) if (!before.has(path)) add(path, "privacy-baseline-grown");
  }
  return findings;
}

function compareFindings(a: PrivacyScanFinding, b: PrivacyScanFinding): number {
  const x = [a.location, a.line, a.kind, a.reason ?? ""] as const;
  const y = [b.location, b.line, b.kind, b.reason ?? ""] as const;
  for (let i = 0; i < x.length; i += 1) {
    if (x[i] < y[i]) return -1;
    if (x[i] > y[i]) return 1;
  }
  return 0;
}

export function analyzePrivacyScan(input: PrivacyScanInput): PrivacyScanResult {
  const pack = input.mode === "pack";
  const tree = input.mode === "tree";
  const denylist = pack ? denylistState(input.denylist) : { entries: null, findings: [] };
  const judge: Judge = { entries: denylist.entries, hitPaths: new Set() };
  for (const unit of input.units)
    if (unit.path !== null && (lineHasEmail(unit.path) || denylistHit(judge, unit.path)))
      judge.hitPaths.add(unit.path);
  const baseline = tree && !input.baselineUnreadable ? (input.baseline ?? []) : [];
  const counts = scanUnits(input, judge, new Set(baseline));
  const stale = tree ? baselineFindings(input, baseline, counts.emailPaths) : [];
  const findings = [...denylist.findings, ...counts.findings, ...stale];
  if (input.units.length === 0)
    findings.push({ location: "input", line: 0, kind: "privacy-input-unreadable", reason: null });
  const unique = new Map(findings.map((finding) => [JSON.stringify(finding), finding]));
  const sorted = [...unique.values()].sort(compareFindings);
  return {
    ok: sorted.length === 0,
    findings: sorted,
    summary: {
      mode: input.mode,
      checked: input.units.length,
      skipped: input.skipped,
      email: counts.email,
      denylist: pack ? counts.denylist : null,
      stale: stale.filter((finding) => finding.kind === "privacy-stale-baseline").length,
      baselined: counts.baselined,
      baseline: tree ? baseline.length : 0,
    },
  };
}

export function privacyScanMessages(result: PrivacyScanResult): string[] {
  const s = result.summary;
  const rows = result.findings.map((f) =>
    [f.location, f.line, f.kind, ...(f.reason ? [f.reason] : [])].join(":"),
  );
  const denylist = s.denylist ?? "unused";
  return [
    ...rows,
    `privacy-scan mode=${s.mode} checked=${s.checked} skipped=${s.skipped} email=${s.email} denylist=${denylist} stale=${s.stale} baselined=${s.baselined} baseline=${s.baseline}`,
  ];
}
