import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fmValue } from "./shared";

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
  const gateText = readFileSync(join(repoRoot, "docs", "governance", "gate-design.md"), "utf8");
  const designRoot = join(repoRoot, "docs", "design", "harness");
  const testRoot = join(repoRoot, "docs", "test-design", "harness");
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
