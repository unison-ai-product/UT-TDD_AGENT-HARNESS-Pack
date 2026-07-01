import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type ArtifactRole,
  type ArtifactStatus,
  type ChainSummary,
  DEFAULT_DESCENT_ADJACENCY,
  DESCENT_LAYERS,
  type DeferEntry,
  type DescentAdjacency,
  type DescentFinding,
  type DescentResult,
  type GradedObligation,
  type ImplAheadViolation,
  type Layer,
  type Obligation,
  type ThinCoverageAdvisory,
  type TraceKeyedArtifact,
} from "./descent-obligation-types";
import { normalizePath } from "./shared";

const DOC_FR_TRACE_RE = /\bFR-L1-(\d+)(?:(?:[〜～]|\.\.)(?:FR-L1-)?(\d+)|((?:\/\d+)+))?/g;
const U_FR_TRACE_RE = /\bU-FR-L1-(\d+)(?:(?:[〜～]|\.\.)(?:U-FR-L1-)?(\d+))?/g;
const EXPLICIT_IMPLEMENTATION_TRACE_RE = /@ut-tdd-trace\s+(FR-L1-\d+)/g;
const ACTIVE_STATUSES = new Set<ArtifactStatus>(["active"]);
const IMPL_ROLES = new Set<ArtifactRole>(["source", "test"]);
const OPEN_DEFER_LAYERS = new Set<Layer>(["L4", "L5", "L6", "L7"]);

function layerRank(layer: Layer): number {
  return DESCENT_LAYERS.indexOf(layer);
}

function isLayer(value: string): value is Layer {
  return (DESCENT_LAYERS as readonly string[]).includes(value);
}

function isActiveArtifact(artifact: TraceKeyedArtifact): boolean {
  return ACTIVE_STATUSES.has(artifact.status);
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function stableObligationKey(obligation: Obligation): string {
  return [
    obligation.traceKey,
    obligation.fromLayer,
    obligation.requiredLayer,
    obligation.kind,
  ].join("|");
}

function traceKeys(text: string, pattern = /\bFR-L1-\d+\b/g): string[] {
  return uniq(text.match(pattern) ?? []).sort();
}

function frId(raw: string): string {
  return `FR-L1-${Number(raw).toString().padStart(2, "0")}`;
}

function boundedRange(startRaw: string, endRaw: string): string[] {
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || end - start > 100) {
    return [frId(startRaw)];
  }
  const ids: string[] = [];
  for (let n = start; n <= end; n++) ids.push(frId(String(n)));
  return ids;
}

/**
 * doc 内の FR trace key を、focused な単一引用 (explicit) と blanket レンジ展開 (ranged) に
 * 分けて provenance を返す。value=true は「レンジ展開のみに由来し focused 引用が無い」(thin)。
 * blanket レンジ (`U-FR-L1-01..U-FR-L1-50` 等) を実体 oracle と誤認する false-confidence の検出に使う。
 */
function documentTraceKeyProvenance(text: string): Map<string, boolean> {
  const explicit = new Set<string>();
  const ranged = new Set<string>();
  for (const match of text.matchAll(DOC_FR_TRACE_RE)) {
    const [, start, end, slashGroup] = match;
    if (end) for (const key of boundedRange(start, end)) ranged.add(key);
    else if (slashGroup) {
      explicit.add(frId(start));
      for (const part of slashGroup.slice(1).split("/")) explicit.add(frId(part));
    } else explicit.add(frId(start));
  }
  for (const match of text.matchAll(U_FR_TRACE_RE)) {
    const [, start, end] = match;
    if (end) for (const key of boundedRange(start, end)) ranged.add(key);
    else explicit.add(frId(start));
  }
  const provenance = new Map<string, boolean>();
  for (const key of explicit) provenance.set(key, false);
  for (const key of ranged) if (!explicit.has(key)) provenance.set(key, true);
  return provenance;
}

function explicitImplementationTraceKeys(text: string): string[] {
  return uniq([...text.matchAll(EXPLICIT_IMPLEMENTATION_TRACE_RE)].map((match) => match[1])).sort();
}

function groupByTrace(artifacts: TraceKeyedArtifact[]): Map<string, TraceKeyedArtifact[]> {
  const groups = new Map<string, TraceKeyedArtifact[]>();
  for (const artifact of artifacts) {
    if (!artifact.traceKey.trim()) continue;
    const list = groups.get(artifact.traceKey) ?? [];
    list.push(artifact);
    groups.set(artifact.traceKey, list);
  }
  return groups;
}

function landedLayer(artifacts: TraceKeyedArtifact[]): Layer {
  return (
    artifacts
      .filter((artifact) => isActiveArtifact(artifact) && IMPL_ROLES.has(artifact.role))
      .map((artifact) => artifact.layer)
      .sort((a, b) => layerRank(a) - layerRank(b))[0] ?? "L7"
  );
}

function validDefer(defer: DeferEntry): boolean {
  return defer.dischargeCondition.trim().length > 0 && defer.owner.trim().length > 0;
}

function frontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const parsed = parseYaml(content.slice(3, end));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function metadataStatus(metadata: Record<string, unknown>, content: string): ArtifactStatus {
  const raw = String(metadata.status ?? "").toLowerCase();
  if (raw === "park" || raw === "parked") return "park";
  if (raw === "defer" || raw === "deferred") return "defer";
  if (raw === "placeholder" || raw === "stub") return "placeholder";
  if (/\bplaceholder_deps\b/i.test(content) && /\bstatus:\s*placeholder\b/i.test(content)) {
    return "placeholder";
  }
  return "active";
}

function recursiveFiles(root: string, predicate: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...recursiveFiles(path, predicate));
    else if (predicate(path)) out.push(path);
  }
  return out.sort();
}

function inferDocLayer(path: string): Layer | null {
  const normalized = normalizePath(path);
  const match = normalized.match(/\bL(\d+)(?:-|\/)/);
  if (match && isLayer(`L${match[1]}`)) return `L${match[1]}` as Layer;
  if (normalized.includes("L1-requirements") || normalized.includes("requirements")) return "L1";
  if (normalized.includes("L3-functional")) return "L3";
  if (normalized.includes("L4-basic")) return "L4";
  if (normalized.includes("L5-detailed")) return "L5";
  if (normalized.includes("L6-function")) return "L6";
  if (normalized.includes("L7-unit")) return "L7";
  if (normalized.includes("L8-integration")) return "L8";
  if (normalized.includes("L9-system")) return "L9";
  if (normalized.includes("L12")) return "L12";
  return null;
}

function inferDocRole(path: string, layer: Layer): ArtifactRole {
  const normalized = normalizePath(path);
  if (normalized.includes("/test-design/")) return "test-design";
  if (layer === "L1" || normalized.includes("requirements")) return "requirement";
  return "design";
}

function artifactRowsForFile(repoRoot: string, path: string): TraceKeyedArtifact[] {
  const content = readFileSync(path, "utf8");
  const metadata = frontmatter(content);
  const rel = normalizePath(relative(repoRoot, path));
  const isTest = rel.startsWith("tests/");
  const isSource = rel.startsWith("src/");
  const layer = isTest || isSource ? "L7" : inferDocLayer(rel);
  if (!layer) return [];
  const role: ArtifactRole = isTest ? "test" : isSource ? "source" : inferDocRole(rel, layer);
  const status = metadataStatus(metadata, content);
  // source/test は @ut-tdd-trace の explicit 引用のみ (provenance=false)。doc は blanket レンジ
  // 展開のみ由来の key を traceKeyFromRange=true として記録する (PLAN-L7-52 C-2)。
  const provenance = isTest || isSource ? null : documentTraceKeyProvenance(content);
  const keys = provenance
    ? [...provenance.keys()].sort()
    : explicitImplementationTraceKeys(content);
  return keys
    .filter(
      (traceKey) =>
        !(
          layer === "L1" &&
          traceKey.startsWith("FR-L1-") &&
          !rel.endsWith("L1-requirements/functional-requirements.md")
        ),
    )
    .map((traceKey) => ({
      traceKey,
      layer,
      role,
      path: rel,
      status,
      traceKeyFromRange: provenance ? (provenance.get(traceKey) ?? false) : false,
    }));
}

function deferRowsForFile(repoRoot: string, path: string): DeferEntry[] {
  const content = readFileSync(path, "utf8");
  if (!/\b(?:placeholder_deps|explicit_l7_defer)\b/i.test(content)) return [];
  const rel = normalizePath(relative(repoRoot, path));
  const fromLayer = inferDocLayer(rel) ?? "L6";
  const rows: DeferEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!/\b(?:placeholder_deps|explicit_l7_defer)\b/i.test(line)) continue;
    const waitingMatch = line.match(/waiting_layer\s*[:=]\s*"?((?:L\d+))"?/i);
    const waitingLayer = waitingMatch && isLayer(waitingMatch[1]) ? waitingMatch[1] : "L7";
    const keys = traceKeys(line);
    for (const traceKey of keys) {
      rows.push({
        traceKey,
        fromLayer,
        waitingLayer,
        waitingSpec: line.trim().slice(0, 240),
        dischargeCondition: /owner\s*[:=]/i.test(line) ? line.trim() : "documented discharge",
        owner: /owner\s*[:=]\s*"?([^",}]+)/i.exec(line)?.[1]?.trim() ?? "documented",
      });
    }
  }
  return rows;
}

export function loadDescentAdjacency(root = process.cwd()): DescentAdjacency {
  const path = join(root, ".ut-tdd", "descent-adjacency.json");
  if (!existsSync(path)) return DEFAULT_DESCENT_ADJACENCY;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DescentAdjacency;
    if (Array.isArray(parsed.rules)) return parsed;
  } catch {
    return DEFAULT_DESCENT_ADJACENCY;
  }
  return DEFAULT_DESCENT_ADJACENCY;
}

export function loadTraceKeyedArtifacts(root = process.cwd()): TraceKeyedArtifact[] {
  const docRoots = [join(root, "docs", "design"), join(root, "docs", "test-design")];
  const files = [
    ...docRoots.flatMap((dir) => recursiveFiles(dir, (path) => path.endsWith(".md"))),
    ...recursiveFiles(join(root, "src"), (path) => path.endsWith(".ts")),
  ];
  return files.flatMap((path) => artifactRowsForFile(root, path));
}

export function loadDeferLedger(root = process.cwd()): DeferEntry[] {
  const files = [
    ...recursiveFiles(join(root, "docs", "design"), (path) => path.endsWith(".md")),
    ...recursiveFiles(join(root, "docs", "test-design"), (path) => path.endsWith(".md")),
    ...recursiveFiles(join(root, "docs", "plans"), (path) => path.endsWith(".md")),
  ];
  return files.flatMap((path) => deferRowsForFile(root, path));
}

/**
 * fr-unit-coverage.md (L6 FR Unit Coverage Matrix) で U-FR oracle が定義された FR の集合を返す。
 * `l6-fr-coverage` ゲートが「全 FR registry 行が L6 spec + 契約 + U-FR oracle に解決する」ことを
 * enforce する正本なので、ここに含まれる FR は L7 redirect 被覆でも substance-verified とみなす。
 * 行形式: `| FR-L1-NN | <spec> | <contract> | U-FR-L1-MM |`。
 */
export function loadFrUnitCoverageOracles(root = process.cwd()): Set<string> {
  const path = join(root, "docs", "design", "harness", "L6-function-design", "fr-unit-coverage.md");
  const oracles = new Set<string>();
  if (!existsSync(path)) return oracles;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const row = line.match(/^\|\s*FR-L1-(\d+)\s*\|/);
    // frId で正規化し、advisory の traceKey 生成 (documentTraceKeyProvenance も frId 経由) と
    // 同一表記 (2 桁 zero-pad) に揃える。1 桁/2 桁の表記揺れで filter が miss しないようにする。
    if (row && /\bU-FR-L1-\d+\b/.test(line)) oracles.add(frId(row[1]));
  }
  return oracles;
}

export function generateObligations(
  artifacts: TraceKeyedArtifact[],
  adjacency: DescentAdjacency,
): Obligation[] {
  const obligations = new Map<string, Obligation>();
  for (const [traceKey, group] of groupByTrace(artifacts)) {
    const active = group.filter(isActiveArtifact);
    const activeLayers = new Set(active.map((artifact) => artifact.layer));
    const hasImpl = active.some((artifact) => IMPL_ROLES.has(artifact.role));
    const landedAt = landedLayer(group);
    for (const rule of adjacency.rules) {
      if (rule.condition === "active") {
        if (rule.from === "*") continue;
        if (!activeLayers.has(rule.from)) continue;
        const obligation: Obligation = {
          traceKey,
          fromLayer: rule.from,
          requiredLayer: rule.to,
          kind: rule.kind,
          reason: `${rule.from}->${rule.to} ${rule.kind}: ${rule.note}`,
        };
        obligations.set(stableObligationKey(obligation), obligation);
        continue;
      }
      if (!hasImpl) continue;
      if (rule.from !== "*" && !activeLayers.has(rule.from)) continue;
      const fromLayer = rule.from === "*" ? landedAt : rule.from;
      const obligation: Obligation = {
        traceKey,
        fromLayer,
        requiredLayer: rule.to,
        kind: rule.kind,
        reason: `${rule.from}->${rule.to} ${rule.kind}: ${rule.note}`,
      };
      obligations.set(stableObligationKey(obligation), obligation);
    }
  }
  return [...obligations.values()].sort(
    (a, b) =>
      a.traceKey.localeCompare(b.traceKey) ||
      layerRank(a.requiredLayer) - layerRank(b.requiredLayer) ||
      a.kind.localeCompare(b.kind),
  );
}

export function analyzeDescentObligations(
  artifacts: TraceKeyedArtifact[],
  adjacency: DescentAdjacency,
  defers: DeferEntry[],
): DescentResult {
  const findings: DescentFinding[] = [];
  const traceable = artifacts.filter((artifact) => {
    if (artifact.traceKey.trim().length > 0) return true;
    findings.push({
      code: "untraceable",
      traceKey: "",
      layer: artifact.layer,
      role: artifact.role,
      path: artifact.path,
      detail: "artifact has no traceKey and is excluded from descent obligation analysis",
    });
    return false;
  });

  const seen = new Map<string, TraceKeyedArtifact>();
  for (const artifact of traceable) {
    if (!IMPL_ROLES.has(artifact.role)) continue;
    const key = `${artifact.traceKey}|${artifact.layer}|${artifact.role}`;
    const previous = seen.get(key);
    if (previous && previous.path !== artifact.path) {
      findings.push({
        code: "duplicate-key",
        traceKey: artifact.traceKey,
        layer: artifact.layer,
        role: artifact.role,
        path: artifact.path,
        detail: `duplicate trace/layer/role also declared by ${previous.path}`,
      });
    } else {
      seen.set(key, artifact);
    }
  }

  const byTrace = groupByTrace(traceable);
  const obligations = generateObligations(traceable, adjacency);
  const unmetLayers = new Set<string>();
  const graded = obligations.map((obligation): GradedObligation => {
    const group = byTrace.get(obligation.traceKey) ?? [];
    const hasImpl = group.some(
      (artifact) => isActiveArtifact(artifact) && IMPL_ROLES.has(artifact.role),
    );
    const satisfied = group.some(
      (artifact) => isActiveArtifact(artifact) && artifact.layer === obligation.requiredLayer,
    );
    if (satisfied) return { ...obligation, status: "satisfied" };
    const defer = defers.find(
      (entry) =>
        entry.traceKey === obligation.traceKey && entry.waitingLayer === obligation.requiredLayer,
    );
    if (defer && !validDefer(defer)) {
      findings.push({
        code: "invalid-defer",
        traceKey: defer.traceKey,
        layer: defer.waitingLayer,
        detail: "defer entry must include dischargeCondition and owner",
      });
      unmetLayers.add(`${obligation.traceKey}|${obligation.requiredLayer}`);
      return { ...obligation, status: "unmet", defer };
    }
    if (defer && !hasImpl) return { ...obligation, status: "deferred", defer };
    unmetLayers.add(`${obligation.traceKey}|${obligation.requiredLayer}`);
    return { ...obligation, status: "unmet", defer };
  });

  const implAhead: ImplAheadViolation[] = [];
  for (const [traceKey, group] of byTrace) {
    const hasImpl = group.some(
      (artifact) => isActiveArtifact(artifact) && IMPL_ROLES.has(artifact.role),
    );
    if (!hasImpl) continue;
    const landedAt = landedLayer(group);
    for (const defer of defers.filter(
      (entry) =>
        entry.traceKey === traceKey &&
        OPEN_DEFER_LAYERS.has(entry.waitingLayer) &&
        validDefer(entry) &&
        !unmetLayers.has(`${traceKey}|${entry.waitingLayer}`),
    )) {
      implAhead.push({
        traceKey,
        landedAt,
        waitingLayer: defer.waitingLayer,
        waitingSpec: defer.waitingSpec,
        owner: defer.owner,
      });
    }
  }

  const chains = [...byTrace.entries()]
    .map(([traceKey, group]): ChainSummary => {
      const traceObligations = graded.filter((obligation) => obligation.traceKey === traceKey);
      const gaps = traceObligations
        .filter((obligation) => obligation.status === "unmet")
        .map((obligation) => obligation.requiredLayer)
        .sort((a, b) => layerRank(a) - layerRank(b));
      const traceFindings = findings.some((finding) => finding.traceKey === traceKey);
      const traceImplAhead = implAhead.some((violation) => violation.traceKey === traceKey);
      return {
        traceKey,
        complete: gaps.length === 0 && !traceFindings && !traceImplAhead,
        firstGap: gaps[0] ?? null,
        layers: uniq([
          ...group.filter(isActiveArtifact).map((artifact) => artifact.layer),
          ...traceObligations.map((obligation) => obligation.requiredLayer),
        ]).sort((a, b) => layerRank(a) - layerRank(b)),
      };
    })
    .sort((a, b) => a.traceKey.localeCompare(b.traceKey));

  // thin-coverage advisory (warn-first、ok に算入しない): L7 で satisfied と判定されたが、
  // L7 unit-test-design 側の被覆が blanket FR レンジ展開のみ (focused oracle 不在) の trace key を
  // 可視化する。descent-obligation 機構自身の false-confidence (coverage≠substance) を surface する。
  // descent-obligation の scope は design⇔test-design pairing (loader は tests/ を走査しない —
  // 実 test 引用の検査は oracle-test-trace の領分)。L7 で satisfied だが unit-test-design 側の被覆が
  // blanket FR レンジ展開のみ由来 (focused oracle 行が無く、fr-unit-coverage.md への redirect に依存)
  // の trace key を thin-coverage advisory として surface する。oracle 正本 (fr-unit-coverage.md)
  // による substance 検証は `filterSubstanceVerifiedAdvisories` で後段合成する (3 引数を保つため)。
  const advisories: ThinCoverageAdvisory[] = [];
  const advisorySeen = new Set<string>();
  for (const obligation of graded) {
    if (obligation.status !== "satisfied" || obligation.requiredLayer !== "L7") continue;
    if (advisorySeen.has(obligation.traceKey)) continue;
    const testDesignL7 = (byTrace.get(obligation.traceKey) ?? []).filter(
      (artifact) =>
        isActiveArtifact(artifact) && artifact.layer === "L7" && artifact.role === "test-design",
    );
    if (
      testDesignL7.length > 0 &&
      testDesignL7.every((artifact) => artifact.traceKeyFromRange === true)
    ) {
      advisorySeen.add(obligation.traceKey);
      advisories.push({
        traceKey: obligation.traceKey,
        requiredLayer: "L7",
        detail:
          "L7 coverage is a blanket-range redirect and the FR has no U-FR oracle in fr-unit-coverage.md (the l6-fr-coverage SSoT); confirm this is a documented defer (e.g. P2 forward-carry) vs a genuine substance gap",
      });
    }
  }
  advisories.sort((a, b) => a.traceKey.localeCompare(b.traceKey));

  const ok =
    graded.every((obligation) => obligation.status !== "unmet") &&
    implAhead.length === 0 &&
    findings.length === 0;
  return { ok, obligations: graded, implAhead, chains, findings, advisories };
}

/**
 * thin-coverage advisory のうち、`l6-fr-coverage` ゲートが enforce する正本 (fr-unit-coverage.md)
 * に U-FR oracle が定義済みの FR を substance-verified として除外する (ゲート間整合)。残る advisory =
 * oracle 正本にも無い真の thin candidate (多くは P2 forward-carry 等の宣言済 defer)。`ok` は不変。
 * 後段合成にしているのは source 関数を 3 引数に保つため (coding-rule max-source-params)。
 */
export function filterSubstanceVerifiedAdvisories(
  result: DescentResult,
  frUnitCoverageOracles: ReadonlySet<string>,
): DescentResult {
  if (frUnitCoverageOracles.size === 0) return result;
  return {
    ...result,
    advisories: result.advisories.filter(
      (advisory) => !frUnitCoverageOracles.has(advisory.traceKey),
    ),
  };
}

/** thin-coverage advisory を message 行へ変換 (warn-first、ok を落とさない、最大 8 件 + 総数)。 */
function advisoryLines(advisories: ThinCoverageAdvisory[]): string[] {
  if (advisories.length === 0) return [];
  const lines = advisories
    .slice(0, 8)
    .map(
      (advisory) =>
        `descent-obligation - advisory (thin-coverage): ${advisory.traceKey} ${advisory.requiredLayer}: ${advisory.detail}`,
    );
  lines.push(
    `descent-obligation - advisory: ${advisories.length} trace key(s) satisfied only by blanket-range L7 coverage (warn-first, ok invariant preserved; hard-gate promotion + oracle back-fill = PLAN-L7-52 C-2/C-4)`,
  );
  return lines;
}

export function descentObligationMessages(result: DescentResult): string[] {
  if (result.ok) {
    return [
      `descent-obligation - OK (graded=${result.obligations.length}, chains=${result.chains.length})`,
      ...advisoryLines(result.advisories),
    ];
  }
  const messages: string[] = [];
  for (const finding of result.findings.slice(0, 8)) {
    messages.push(
      `descent-obligation - violation: ${finding.code} ${finding.traceKey || "-"} ${finding.layer ?? "-"} ${finding.role ?? "-"}: ${finding.detail}`,
    );
  }
  for (const obligation of result.obligations.filter((row) => row.status === "unmet").slice(0, 8)) {
    messages.push(
      `descent-obligation - unmet: ${obligation.traceKey} requires ${obligation.requiredLayer} (${obligation.kind}) from ${obligation.fromLayer}: ${obligation.reason}`,
    );
  }
  for (const violation of result.implAhead.slice(0, 8)) {
    messages.push(
      `descent-obligation - impl-ahead: ${violation.traceKey} landed at ${violation.landedAt} while ${violation.waitingLayer} defer remains open (${violation.waitingSpec})`,
    );
  }
  messages.push(...advisoryLines(result.advisories));
  return messages;
}
