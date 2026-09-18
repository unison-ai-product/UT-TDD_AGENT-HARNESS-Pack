import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { deriveLegacyAssetId } from "./legacy-plan-adapter.ts";
import { loadProjectIdentityFromHead } from "./project-identity-loader.ts";

export interface LegacyPlanInventoryItem {
  readonly sourcePath: string;
  readonly legacyPlanId: string;
  readonly assetId: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly knownFrontmatter: Readonly<Record<string, unknown>>;
  readonly unknownFrontmatter: Readonly<Record<string, unknown>>;
  readonly frontmatterDigest: string;
  readonly bodyDigest: string;
  readonly sourceBlobOid: string;
  readonly sourceContentDigest: string;
  readonly sourceCommit: string;
}

export interface LegacyPlanCollisionGroup {
  readonly numericCore: string;
  readonly planIds: readonly string[];
}

export type LegacyPlanInventoryResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly repositoryIdentity: string;
        readonly sourceCommit: string;
        readonly items: readonly LegacyPlanInventoryItem[];
        readonly collisionGroups: readonly LegacyPlanCollisionGroup[];
        readonly inventoryDigest: string;
      };
    }
  | { readonly ok: false; readonly error: { readonly ruleId: string; readonly path?: string } };

export function buildLegacyPlanInventory(repoRoot: string): LegacyPlanInventoryResult {
  const identity = loadProjectIdentityFromHead({ repoRoot });
  if (!identity.ok) return { ok: false, error: identity.error };
  try {
    const sourceCommit = gitText(repoRoot, ["rev-parse", "HEAD"]).trim();
    const paths = gitText(repoRoot, ["ls-tree", "-r", "--name-only", "HEAD", "--", "docs/plans"])
      .split(/\r?\n/)
      .filter((path) => /^docs\/plans\/PLAN-.*\.md$/.test(path))
      .sort(compareBytes);
    const blobs = gitHeadFiles(repoRoot, paths);
    const items: LegacyPlanInventoryItem[] = [];
    for (const path of paths) {
      const blob = blobs.get(path);
      if (!blob) return { ok: false, error: { ruleId: "plan-migration-loss", path } };
      const parsed = parseLegacyPlanSource(blob.content);
      if (!parsed) return { ok: false, error: { ruleId: "plan-migration-loss", path } };
      const split = splitFrontmatter(parsed.frontmatter);
      items.push(
        Object.freeze({
          sourcePath: path,
          legacyPlanId: parsed.planId,
          assetId: deriveLegacyAssetId(identity.value.repositoryIdentity, parsed.planId),
          frontmatter: deepFreeze(parsed.frontmatter),
          knownFrontmatter: deepFreeze(split.known),
          unknownFrontmatter: deepFreeze(split.unknown),
          frontmatterDigest: sha256(parsed.rawFrontmatter),
          bodyDigest: sha256(parsed.body),
          sourceBlobOid: blob.blobOid,
          sourceContentDigest: sha256(blob.content),
          sourceCommit,
        }),
      );
    }
    if (!hasUnique(items, (item) => item.sourcePath)) {
      return { ok: false, error: { ruleId: "plan-migration-loss" } };
    }
    if (
      !hasUnique(items, (item) => item.legacyPlanId) ||
      !hasUnique(items, (item) => item.assetId)
    ) {
      return { ok: false, error: { ruleId: "plan-migration-collision" } };
    }
    const collisionGroups = collisions(items);
    return {
      ok: true,
      value: Object.freeze({
        repositoryIdentity: identity.value.repositoryIdentity,
        sourceCommit,
        items: Object.freeze(items),
        collisionGroups,
        inventoryDigest: inventoryProjectionDigest({
          repositoryIdentity: identity.value.repositoryIdentity,
          identityReceiptDigest: identity.value.provenance.receiptDigest,
          sourceCommit,
          collisions: collisionGroups.map((group) => [group.numericCore, group.planIds]),
          items: items.map((item) => [
            item.sourcePath,
            item.legacyPlanId,
            item.assetId,
            item.frontmatterDigest,
            item.bodyDigest,
            item.sourceBlobOid,
            item.sourceContentDigest,
            canonical(item.knownFrontmatter),
            canonical(item.unknownFrontmatter),
          ]),
        }),
      }),
    };
  } catch {
    return { ok: false, error: { ruleId: "plan-migration-loss" } };
  }
}

export function inventoryProjectionDigest(projection: Readonly<Record<string, unknown>>): string {
  return sha256(canonical(projection));
}

export function parseLegacyPlanSource(content: string): {
  planId: string;
  frontmatter: Record<string, unknown>;
  rawFrontmatter: string;
  body: string;
} | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match) return null;
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length > 0 || !validYamlNode(document.contents)) return null;
  const value = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const frontmatter = value as Record<string, unknown>;
  if (typeof frontmatter.plan_id !== "string" || !frontmatter.plan_id.trim()) return null;
  return {
    planId: frontmatter.plan_id,
    frontmatter,
    rawFrontmatter: match[1],
    body: match[2],
  };
}

const knownFrontmatterKeys = new Set([
  "plan_id",
  "title",
  "kind",
  "drive",
  "status",
  "layer",
  "sub_doc",
  "master_hub",
  "workflow_phase",
  "parent_design",
  "decision_outcome",
  "confirmed_reverse_type",
  "scrum_type",
  "forward_routing",
  "promotion_strategy",
  "agent_slots",
  "generates",
  "dependencies",
  "github_issue_id",
  "backprop_decision",
  "backprop_decision_reason",
  "version_target",
  "route_signal",
  "route_mode",
  "verification_gate",
  "v2_import",
  "review_evidence",
  "supersedes",
  "created",
  "updated",
  "owner",
  "related_l0",
  "pair_artifact",
  "next_pair_freeze",
]);

function splitFrontmatter(frontmatter: Readonly<Record<string, unknown>>): {
  known: Record<string, unknown>;
  unknown: Record<string, unknown>;
} {
  const known: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    (knownFrontmatterKeys.has(key) ? known : unknown)[key] = value;
  }
  return { known, unknown };
}

function validYamlNode(node: unknown): boolean {
  if (node == null) return true;
  if (isAlias(node)) return false;
  if (isScalar(node)) {
    return (
      node.anchor == null &&
      node.tag == null &&
      (typeof node.value !== "number" || Number.isSafeInteger(node.value))
    );
  }
  if (isSeq(node)) {
    return node.anchor == null && node.tag == null && node.items.every(validYamlNode);
  }
  if (isMap(node)) {
    return (
      node.anchor == null &&
      node.tag == null &&
      node.items.every(
        (pair) =>
          isScalar(pair.key) &&
          typeof pair.key.value === "string" &&
          pair.key.value !== "<<" &&
          validYamlNode(pair.value),
      )
    );
  }
  return false;
}

function hasUnique<T>(items: readonly T[], select: (item: T) => string): boolean {
  return new Set(items.map(select)).size === items.length;
}

function collisions(
  items: readonly LegacyPlanInventoryItem[],
): readonly LegacyPlanCollisionGroup[] {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const core = /^(PLAN-(?:L(?:[0-9]|1[0-4])|DISCOVERY|REVERSE|RECOVERY|M)-\d+)/.exec(
      item.legacyPlanId,
    )?.[1];
    if (!core) continue;
    groups.set(core, [...(groups.get(core) ?? []), item.legacyPlanId]);
  }
  return Object.freeze(
    [...groups]
      .filter(([, planIds]) => planIds.length > 1)
      .sort(([left], [right]) => compareBytes(left, right))
      .map(([numericCore, planIds]) =>
        Object.freeze({ numericCore, planIds: Object.freeze(planIds.sort(compareBytes)) }),
      ),
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareBytes(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitText(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function gitHeadFiles(
  repoRoot: string,
  paths: readonly string[],
): ReadonlyMap<string, { content: string; blobOid: string }> {
  const output = execFileSync("git", ["-C", repoRoot, "cat-file", "--batch"], {
    input: paths.map((path) => `HEAD:${path}\n`).join(""),
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Map<string, { content: string; blobOid: string }>();
  let offset = 0;
  for (const path of paths) {
    const lineEnd = output.indexOf(10, offset);
    if (lineEnd < 0) throw new Error(`plan-migration-loss:${path}`);
    const header = output.subarray(offset, lineEnd).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (
      header.length !== 3 ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(header[0]) ||
      header[1] !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error(`plan-migration-loss:${path}`);
    }
    const start = lineEnd + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 10) throw new Error(`plan-migration-loss:${path}`);
    files.set(path, { content: output.subarray(start, end).toString("utf8"), blobOid: header[0] });
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error("plan-migration-loss:batch-tail");
  return files;
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
