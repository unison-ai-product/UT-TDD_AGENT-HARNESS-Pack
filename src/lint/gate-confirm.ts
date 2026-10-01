import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVModelRoots } from "../shared/design-root.ts";
import { fmValue } from "./shared.ts";

declare const __UT_TDD_BUNDLED__: boolean;

const bundled = typeof __UT_TDD_BUNDLED__ !== "undefined" && __UT_TDD_BUNDLED__ === true;

interface EmbeddedGateAsset {
  readonly path: string;
  readonly content: string;
}

export type GateAssetPath =
  | "docs/governance/gate-design.md"
  | "docs/process/gates.md"
  | "docs/process/vmodel-contract.yaml";

// Literal require paths are esbuild text-loader inputs and are included in the
// authoritative bundle receipt. Source execution keeps this index empty.
const EMBEDDED_GATE_ASSETS: readonly EmbeddedGateAsset[] = bundled
  ? [
      {
        path: "docs/governance/gate-design.md",
        content: require("ut-tdd-gate-assets/docs/governance/gate-design.md") as string,
      },
      {
        path: "docs/process/gates.md",
        content: require("ut-tdd-gate-assets/docs/process/gates.md") as string,
      },
      {
        path: "docs/process/vmodel-contract.yaml",
        content: require("ut-tdd-gate-assets/docs/process/vmodel-contract.yaml") as string,
      },
    ]
  : [];

export function readGateAssetText(repoRoot: string, path: GateAssetPath): string {
  const consumerPath = join(repoRoot, path);
  if (existsSync(consumerPath)) return readFileSync(consumerPath, "utf8");
  if (bundled) {
    const asset = EMBEDDED_GATE_ASSETS.find((candidate) => candidate.path === path);
    if (!asset) throw new Error(`embedded gate asset is missing from the Node bundle: ${path}`);
    return asset.content;
  }
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return readFileSync(resolve(sourceRoot, path), "utf8");
}

export interface GateStatus {
  gate: string;
  layer: string;
  status: string;
  pass: boolean;
}

export interface ConfirmDoc {
  file: string;
  layer: string;
  status: string;
  kind: "design" | "test-design";
}

export interface GateConfirmDocs {
  gateText: string;
  docs: ConfirmDoc[];
}

export interface GateConfirmResult {
  violations: { file: string; layer: string; gate: string; gateStatus: string }[];
  skipped: boolean;
  ok: boolean;
}

export function layerToGate(layer: string): string | null {
  const m = layer.match(/^L(\d+)$/);
  if (!m) return null;
  return `G${m[1]}`;
}

function gateToLayer(gate: string): string | null {
  const m = gate.match(/^G(\d+)/);
  if (!m) return null;
  return `L${m[1]}`;
}

function gateLedgerSection(gateText: string): string {
  const start = gateText.search(/^##\s+§2\s+/m);
  if (start < 0) return gateText;
  const rest = gateText.slice(start);
  const next = rest.slice(1).search(/^##\s+/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

export function parseGateStatuses(gateText: string): GateStatus[] {
  const rows: GateStatus[] = [];
  for (const line of gateLedgerSection(gateText).split(/\r?\n/)) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.replace(/\*\*/g, "").trim());
    if (cells.length < 2) continue;
    const gate = cells[0].match(/G\d+(?:\.\d+)?/)?.[0];
    const explicitLayer = cells[1].match(/L\d+/)?.[0];
    const layer = explicitLayer ?? (gate ? gateToLayer(gate) : null);
    const status = explicitLayer ? (cells[2] ?? "") : (cells[1] ?? "");
    if (!gate || !layer) continue;
    rows.push({ gate, layer, status, pass: /\bPASS\b/i.test(status) });
  }
  return rows;
}

export function parseConfirmDoc(
  file: string,
  content: string,
  kind: ConfirmDoc["kind"],
): ConfirmDoc {
  return {
    file,
    layer: fmValue(content, "layer") ?? "unknown",
    status: fmValue(content, "status") ?? "unknown",
    kind,
  };
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkMarkdown(p));
    else if (entry.endsWith(".md")) out.push(p);
  }
  return out;
}

export function loadGateConfirmDocs(repoRoot: string = process.cwd()): GateConfirmDocs {
  const gateText = readGateAssetText(repoRoot, "docs/governance/gate-design.md");
  const roots = resolveVModelRoots(repoRoot);
  const designRoot = join(repoRoot, roots.designRoot);
  const testRoot = join(repoRoot, roots.testDesignRoot);
  const docs: ConfirmDoc[] = [];
  for (const p of walkMarkdown(designRoot)) {
    docs.push(parseConfirmDoc(p, readFileSync(p, "utf8"), "design"));
  }
  for (const p of walkMarkdown(testRoot)) {
    docs.push(parseConfirmDoc(p, readFileSync(p, "utf8"), "test-design"));
  }
  return { gateText, docs };
}

export function analyzeGateConfirm(input: GateConfirmDocs): GateConfirmResult {
  const statuses = parseGateStatuses(input.gateText);
  if (statuses.length === 0) return { violations: [], skipped: true, ok: false };
  const byGate = new Map(statuses.map((s) => [s.gate, s]));
  const violations: GateConfirmResult["violations"] = [];
  for (const doc of input.docs) {
    if (doc.status !== "confirmed") continue;
    const gate = layerToGate(doc.layer);
    if (!gate) continue;
    const gateStatus = byGate.get(gate);
    if (!gateStatus) continue;
    if (!gateStatus.pass) {
      violations.push({ file: doc.file, layer: doc.layer, gate, gateStatus: gateStatus.status });
    }
  }
  return { violations, skipped: false, ok: violations.length === 0 };
}

export function gateConfirmMessages(result: GateConfirmResult): string[] {
  if (result.skipped) return ["gate-confirm - violation: gate-design ledger could not be parsed"];
  if (result.violations.length === 0) {
    return ["gate-confirm — OK (confirmed doc は gate PASS 台帳と整合)"];
  }
  const ids = result.violations
    .map((v) => `${v.file}:${v.layer}/${v.gate}=${v.gateStatus}`)
    .join(", ");
  return [
    `gate-confirm — ⚠ gate 未PASSなのに confirmed の design/test-design doc ${result.violations.length} 件 (${ids})。freeze 偽装を確認 (IMP-079)`,
  ];
}
