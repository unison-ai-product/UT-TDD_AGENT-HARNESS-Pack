import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitize } from "./session-log";

export type ProviderRuntime = "claude" | "codex";

export interface ProviderHandoverContext {
  summary: string;
  next_actions: string[];
  files: string[];
}

export interface ProviderHandoverPackage {
  schema_version: "provider-handover.v1";
  handover_kind: "mechanical";
  handover_id: string;
  from: ProviderRuntime;
  to: ProviderRuntime;
  active_plan: string;
  budget: string | null;
  context: ProviderHandoverContext;
  created_at: string;
}

export interface ProviderHandoverInput {
  from: ProviderRuntime;
  to: ProviderRuntime;
  activePlan: string;
  budget?: string | null;
  summary: string;
  nextActions?: string[];
  files?: string[];
}

export interface ProviderHandoverDeps {
  repoRoot: string;
  now: () => string;
  readText: (path: string) => string | null;
  writeText: (path: string, content: string) => void;
}

const PROVIDER_DIR = join(".ut-tdd", "handover", "provider");
const PROVIDER_CURRENT = join(PROVIDER_DIR, "CURRENT.json");

export function providerHandoverPath(repoRoot: string, handoverId: string): string {
  return join(repoRoot, PROVIDER_DIR, `${handoverId}.json`);
}

function normalizeToken(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function buildProviderHandover(
  input: ProviderHandoverInput,
  now: string,
): ProviderHandoverPackage {
  if (input.from === input.to) {
    throw new Error("provider handover requires different from/to runtimes");
  }
  if (!input.activePlan.trim()) {
    throw new Error("provider handover requires activePlan");
  }
  if (!input.summary.trim()) {
    throw new Error("provider handover requires summary");
  }
  const plan = sanitize(input.activePlan.trim());
  const timeToken = now.replace(/[^0-9]/g, "").slice(0, 14) || "unknown-time";
  const handoverId = `${timeToken}-${input.from}-to-${input.to}-${normalizeToken(plan)}`;
  return {
    schema_version: "provider-handover.v1",
    handover_kind: "mechanical",
    handover_id: handoverId,
    from: input.from,
    to: input.to,
    active_plan: plan,
    budget: input.budget ? sanitize(input.budget.trim()) : null,
    context: {
      summary: sanitize(input.summary.trim()),
      next_actions: (input.nextActions ?? []).map((a) => sanitize(a.trim())).filter(Boolean),
      files: (input.files ?? []).map((f) => sanitize(f.trim())).filter(Boolean),
    },
    created_at: now,
  };
}

export function writeProviderHandover(
  pkg: ProviderHandoverPackage,
  deps: ProviderHandoverDeps,
): string[] {
  const rel = join(PROVIDER_DIR, `${pkg.handover_id}.json`);
  deps.writeText(join(deps.repoRoot, rel), `${JSON.stringify(pkg, null, 2)}\n`);
  deps.writeText(join(deps.repoRoot, PROVIDER_CURRENT), `${JSON.stringify(pkg, null, 2)}\n`);
  return [rel, PROVIDER_CURRENT];
}

export function readProviderHandoverCurrent(deps: {
  repoRoot: string;
  readText: (path: string) => string | null;
}): ProviderHandoverPackage | null {
  try {
    const raw = deps.readText(join(deps.repoRoot, PROVIDER_CURRENT));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProviderHandoverPackage;
    return parsed.schema_version === "provider-handover.v1" ? parsed : null;
  } catch {
    return null;
  }
}

export function runProviderHandover(
  input: ProviderHandoverInput & { dryRun?: boolean },
  deps: ProviderHandoverDeps,
): { package: ProviderHandoverPackage; written: string[] } {
  const pkg = buildProviderHandover(input, deps.now());
  if (input.dryRun) return { package: pkg, written: [] };
  return { package: pkg, written: writeProviderHandover(pkg, deps) };
}

export function nodeProviderHandoverDeps(repoRoot: string): ProviderHandoverDeps {
  return {
    repoRoot,
    now: () => new Date().toISOString(),
    readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeText: (p, c) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c, "utf8");
    },
  };
}
