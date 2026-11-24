import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveVModelRoots } from "../shared/design-root.ts";
import { hasDbcTable } from "./shared.ts";

export interface L6CompletionDoc {
  path: string;
  text: string;
}

export interface L6CompletionInputs {
  l6Docs: L6CompletionDoc[];
  /** @deprecated Retained for caller compatibility; PLAN inputs are ignored. */
  l6Plans: L6CompletionDoc[];
  l7Text: string;
  /** Actual L7 documents; omitted only for compatibility with legacy direct callers. */
  l7Docs?: L6CompletionDoc[];
  gateText: string;
}

export interface L6CompletionResult {
  totalDocs: number;
  draftDocs: string[];
  missingDocIssues: string[];
  missingDocPairArtifacts: string[];
  missingL7DocRefs: string[];
  weakContractDocs: string[];
  l7Status: string | null;
  g6Status: string | null;
  freezeInputReady: boolean;
  ready: boolean;
}

const ELIGIBLE_L7_PATH_RE = /^docs\/test-design\/harness\/L7-[^/\\]+\.md$/;

type Frontmatter = Record<string, unknown>;

function frontmatterOf(text: string): Frontmatter | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  try {
    const parsed: unknown = parseYaml(match[1]);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Frontmatter)
      : null;
  } catch {
    return null;
  }
}

function frontmatterValue(text: string, key: string): unknown {
  const parsed = frontmatterOf(text);
  if (parsed) return parsed[key];
  // Older pure-function callers pass bare one-line metadata rather than Markdown frontmatter.
  if (/^---\r?\n/.test(text)) return undefined;
  try {
    const bare: unknown = parseYaml(text);
    if (bare !== null && typeof bare === "object" && !Array.isArray(bare)) {
      return (bare as Frontmatter)[key];
    }
  } catch {
    // Fall through to the historical line-based metadata fixtures below.
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escapedKey}:\\s*(.*?)\\s*$`, "m"));
  return match?.[1];
}

function statusOf(text: string): string | null {
  const status = frontmatterValue(text, "status");
  return typeof status === "string" ? status : null;
}

function frontmatterStatusOf(text: string): string | null {
  const status = frontmatterOf(text)?.status;
  return typeof status === "string" ? status : null;
}

function docIssueOf(text: string): number | null {
  const value = frontmatterValue(text, "issue");
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    const issue = Number(value.trim());
    return Number.isSafeInteger(issue) ? issue : null;
  }
  return null;
}

function docPairArtifactOf(text: string): string | null {
  const value = frontmatterValue(text, "pair_artifact");
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function l7Body(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function isEligibleL7Doc(doc: L6CompletionDoc): boolean {
  if (!ELIGIBLE_L7_PATH_RE.test(doc.path) || !/^---\r?\n/.test(doc.text)) return false;
  const frontmatter = frontmatterOf(doc.text);
  return frontmatter?.artifact_type === "test_design" && frontmatter.executed_at_layer === "L7";
}

function hasUnitContractSubstance(text: string): boolean {
  const hasStructuredDbcTable = hasDbcTable(text);
  const signatureCount = (text.match(/\b[A-Za-z][A-Za-z0-9_]*\([^)]*\)\s*=>/g) ?? []).length;
  const oracleCount = (text.match(/\bU-[A-Z0-9-]+/g) ?? []).length;
  const dbcMarkerCount = (text.match(/\b(pre|post|invariant|oracle|DbC)\b/gi) ?? []).length;
  const hasLegacyExplicitMarker =
    /L6 contract marker/i.test(text) && signatureCount >= 1 && oracleCount >= 1;
  return (
    (hasStructuredDbcTable && signatureCount >= 1 && oracleCount >= 1) ||
    (signatureCount >= 1 && oracleCount >= 1 && dbcMarkerCount >= 3) ||
    hasLegacyExplicitMarker
  );
}

function gateG6Status(gateText: string): string | null {
  for (const line of gateText.split(/\r?\n/)) {
    if (!line.includes("| G6")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    return cells[1] ?? null;
  }
  return null;
}

function isPassStatus(status: string | null): boolean {
  return status !== null && /PASS/.test(status);
}

export function analyzeL6Completion(inputs: L6CompletionInputs): L6CompletionResult {
  const hasExplicitL7Docs = inputs.l7Docs !== undefined;
  const l7Docs = inputs.l7Docs ?? [
    {
      path: "docs/test-design/harness/L7-unit-test-design.md",
      text: inputs.l7Text,
    },
  ];
  const eligibleL7Docs = new Map(
    l7Docs
      .filter((doc) => !hasExplicitL7Docs || isEligibleL7Doc(doc))
      .map((doc) => [doc.path, doc] as const),
  );

  const draftDocs = inputs.l6Docs
    .filter((doc) => statusOf(doc.text) !== "confirmed")
    .map((doc) => doc.path)
    .sort();
  const missingDocIssues = inputs.l6Docs
    .filter((doc) => docIssueOf(doc.text) === null)
    .map((doc) => doc.path)
    .sort();
  const missingDocPairArtifacts = inputs.l6Docs
    .filter((doc) => {
      const pairPath = docPairArtifactOf(doc.text);
      return (
        pairPath === null || !ELIGIBLE_L7_PATH_RE.test(pairPath) || !eligibleL7Docs.has(pairPath)
      );
    })
    .map((doc) => doc.path)
    .sort();
  const missingL7DocRefs = inputs.l6Docs
    .filter((doc) => {
      const pairPath = docPairArtifactOf(doc.text);
      const pairDoc = pairPath === null ? undefined : eligibleL7Docs.get(pairPath);
      return pairDoc === undefined || !l7Body(pairDoc.text).includes(basename(doc.path));
    })
    .map((doc) => doc.path)
    .sort();
  const weakContractDocs = inputs.l6Docs
    .filter((doc) => !hasUnitContractSubstance(doc.text))
    .map((doc) => doc.path)
    .sort();

  const g6Status = gateG6Status(inputs.gateText);
  const selectedPairDocs = new Map<string, L6CompletionDoc>();
  for (const doc of inputs.l6Docs) {
    const pairPath = docPairArtifactOf(doc.text);
    if (pairPath === null) continue;
    const pairDoc = eligibleL7Docs.get(pairPath);
    if (pairDoc !== undefined) selectedPairDocs.set(pairPath, pairDoc);
  }
  const selectedPairStatuses = [...selectedPairDocs.values()].map((doc) =>
    hasExplicitL7Docs ? frontmatterStatusOf(doc.text) : statusOf(doc.text),
  );
  const draftPairDocs = selectedPairStatuses.filter((status) => status !== "confirmed");
  const l7Status =
    hasExplicitL7Docs && selectedPairStatuses.length > 0
      ? selectedPairStatuses.every((status) => status === "confirmed")
        ? "confirmed"
        : selectedPairStatuses.some((status) => status !== null)
          ? "draft"
          : null
      : statusOf(inputs.l7Text);

  const freezeInputReady =
    inputs.l6Docs.length > 0 &&
    missingDocIssues.length === 0 &&
    missingDocPairArtifacts.length === 0 &&
    missingL7DocRefs.length === 0 &&
    weakContractDocs.length === 0;

  const ready =
    inputs.l6Docs.length > 0 &&
    draftDocs.length === 0 &&
    missingDocIssues.length === 0 &&
    missingDocPairArtifacts.length === 0 &&
    missingL7DocRefs.length === 0 &&
    weakContractDocs.length === 0 &&
    draftPairDocs.length === 0 &&
    isPassStatus(g6Status);

  return {
    totalDocs: inputs.l6Docs.length,
    draftDocs,
    missingDocIssues,
    missingDocPairArtifacts,
    missingL7DocRefs,
    weakContractDocs,
    l7Status,
    g6Status,
    freezeInputReady,
    ready,
  };
}

export function loadL6CompletionInputs(repoRoot: string): L6CompletionInputs {
  const roots = resolveVModelRoots(repoRoot);
  const l6Dir = join(repoRoot, roots.designRoot, "L6-function-design");
  const l6Docs = (existsSync(l6Dir) ? readdirSync(l6Dir) : [])
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const path = join(l6Dir, name);
      const text = readFileSync(path, "utf8");
      if (frontmatterOf(text) === null) {
        throw new Error(`L6 completion input has invalid frontmatter: ${path}`);
      }
      return {
        path: `${roots.designRoot}/L6-function-design/${name}`,
        text,
      };
    });
  const l7Dir = join(repoRoot, roots.testDesignRoot);
  const l7Docs = (existsSync(l7Dir) ? readdirSync(l7Dir) : [])
    .filter((name) => /^L7-.*\.md$/.test(name))
    .map((name) => {
      const path = join(l7Dir, name);
      return { path: `${roots.testDesignRoot}/${name}`, text: readFileSync(path, "utf8") };
    });
  const l7Text = l7Docs.find((doc) => basename(doc.path) === "L7-unit-test-design.md")?.text ?? "";
  return {
    l6Docs,
    l6Plans: [],
    l7Text,
    l7Docs,
    gateText: existsSync(join(repoRoot, "docs", "governance", "gate-design.md"))
      ? readFileSync(join(repoRoot, "docs", "governance", "gate-design.md"), "utf8")
      : "",
  };
}

export function canLoadL6CompletionInputs(repoRoot: string): boolean {
  const roots = resolveVModelRoots(repoRoot);
  return (
    existsSync(join(repoRoot, roots.designRoot, "L6-function-design")) &&
    existsSync(join(repoRoot, roots.testDesignRoot)) &&
    existsSync(join(repoRoot, "docs", "governance", "gate-design.md"))
  );
}

export function l6CompletionMessages(result: L6CompletionResult): string[] {
  if (result.ready) {
    return [`l6-completion — OK (L6 docs ${result.totalDocs}件、L7 confirmed、G6 PASS)`];
  }
  const messages = [
    `l6-completion — not ready (docs=${result.totalDocs}, draft_docs=${result.draftDocs.length}, l7=${result.l7Status ?? "missing"}, g6=${result.g6Status ?? "missing"})`,
  ];
  messages.push(
    `l6-completion — freeze-inputs ${result.freezeInputReady ? "OK" : "not ready"} (trace/substance before status flip)`,
  );
  messages.push(`l6-completion — unit-contract substance gaps: ${result.weakContractDocs.length}`);
  if (result.draftDocs.length > 0) {
    messages.push(`l6-completion — draft docs: ${result.draftDocs.join(", ")}`);
  }
  if (result.missingDocIssues.length > 0) {
    messages.push(
      `l6-completion — L6 docs without a positive issue owner: ${result.missingDocIssues.join(", ")}`,
    );
  }
  if (result.missingDocPairArtifacts.length > 0) {
    messages.push(
      `l6-completion — L6 docs without L7 pair_artifact: ${result.missingDocPairArtifacts.join(", ")}`,
    );
  }
  if (result.missingL7DocRefs.length > 0) {
    messages.push(
      `l6-completion — L6 docs not referenced by L7: ${result.missingL7DocRefs.join(", ")}`,
    );
  }
  if (result.weakContractDocs.length > 0) {
    messages.push(
      `l6-completion — L6 docs without unit-contract substance: ${result.weakContractDocs.join(", ")}`,
    );
  }
  return messages;
}
