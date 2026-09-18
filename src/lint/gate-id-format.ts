import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORWARD_GATE_ID_PATTERN = /^G(?:0\.5|[1-9]|1[0-4])$/;
const GATE_TOKEN_PATTERN = /\bG\d+(?:\.\d+)?\b/g;
const GATEISH_PATTERN = /\bgate[-_\s]?\d+\b/i;

export interface GateIdFormatMarkdownDoc {
  file: string;
  content: string;
}

export interface GateIdFormatEvidenceManifest {
  file: string;
  gate: string;
}

export interface GateIdFormatInput {
  markdownDocs: GateIdFormatMarkdownDoc[];
  evidenceManifests: GateIdFormatEvidenceManifest[];
}

export interface GateIdFormatViolation {
  file: string;
  gate: string;
  reason: "invalid_forward_gate_id";
}

export interface GateIdFormatResult {
  checked: number;
  violations: GateIdFormatViolation[];
  ok: boolean;
}

function cleanMarkdownCell(cell: string): string {
  return cell.replaceAll("*", "").replaceAll("`", "").trim();
}

function splitTableLine(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanMarkdownCell);
}

function gateRefsFromMarkdownTable(doc: GateIdFormatMarkdownDoc): { file: string; gate: string }[] {
  const refs: { file: string; gate: string }[] = [];
  for (const line of doc.content.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    if (/^\|\s*:?-{3,}/.test(line)) continue;

    const firstCell = splitTableLine(line)[0] ?? "";
    if (!firstCell || firstCell.toLowerCase() === "gate" || firstCell === "ゲート") continue;
    const tokens = [...firstCell.matchAll(GATE_TOKEN_PATTERN)].map((m) => m[0]);
    if (tokens.length > 0) {
      refs.push(...tokens.map((gate) => ({ file: doc.file, gate })));
      continue;
    }
    if (GATEISH_PATTERN.test(firstCell)) {
      refs.push({ file: doc.file, gate: firstCell });
    }
  }
  return refs;
}

function readEvidenceManifestGate(
  file: string,
  content: string,
): GateIdFormatEvidenceManifest | null {
  try {
    const raw = JSON.parse(content) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const gate = (raw as Record<string, unknown>).gate;
    return typeof gate === "string" && gate.length > 0 ? { file, gate } : null;
  } catch {
    return null;
  }
}

function walkJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkJsonFiles(path));
    } else if (entry.endsWith(".json")) {
      files.push(path);
    }
  }
  return files;
}

export function loadGateIdFormatInput(repoRoot = process.cwd()): GateIdFormatInput {
  const markdownDocs = [
    {
      file: "docs/governance/gate-design.md",
      content: readFileSync(join(repoRoot, "docs", "governance", "gate-design.md"), "utf8"),
    },
    {
      file: "docs/process/gates.md",
      content: readFileSync(join(repoRoot, "docs", "process", "gates.md"), "utf8"),
    },
  ];

  const evidenceRoot = join(repoRoot, ".ut-tdd", "evidence");
  const evidenceManifests = walkJsonFiles(evidenceRoot)
    .map((path) => readEvidenceManifestGate(path.replaceAll("\\", "/"), readFileSync(path, "utf8")))
    .filter((entry): entry is GateIdFormatEvidenceManifest => Boolean(entry));

  return { markdownDocs, evidenceManifests };
}

export function analyzeGateIdFormat(input: GateIdFormatInput): GateIdFormatResult {
  const refs = [
    ...input.markdownDocs.flatMap(gateRefsFromMarkdownTable),
    ...input.evidenceManifests.map((manifest) => ({
      file: manifest.file,
      gate: manifest.gate,
    })),
  ];
  const violations = refs
    .filter((ref) => !FORWARD_GATE_ID_PATTERN.test(ref.gate))
    .map((ref) => ({
      ...ref,
      reason: "invalid_forward_gate_id" as const,
    }));
  return { checked: refs.length, violations, ok: violations.length === 0 };
}

export function gateIdFormatMessages(result: GateIdFormatResult): string[] {
  if (result.ok) {
    return [`gate-id-format - OK (checked=${result.checked}, forward gates G0.5/G1-G14)`];
  }
  const sample = result.violations
    .slice(0, 8)
    .map((violation) => `${violation.file}:${violation.gate}`)
    .join(", ");
  return [
    `gate-id-format - violation: invalid forward GateId ${result.violations.length}件 (${sample})`,
  ];
}
