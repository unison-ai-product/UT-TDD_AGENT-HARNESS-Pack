import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TargetRegistry } from "../domain/target-resolver.ts";
import { parseStrictMarkdownTable } from "./strict-markdown-table.ts";

export function buildTrackedTargetRegistry(
  repoRoot: string,
  familyRefs: readonly string[],
): TargetRegistry {
  const paths = trackedPaths(repoRoot);
  const aliases: Record<string, string[]> = {};
  for (const path of paths) {
    if (!path.startsWith("docs/plans/") || !path.endsWith(".md")) continue;
    const content = readFileSync(join(repoRoot, path), "utf8");
    const planId = /^plan_id:\s*([^\s]+)\s*$/m.exec(content)?.[1];
    if (!planId) continue;
    addAlias(aliases, planId, planId);
    const short = /^(PLAN-(?:L\d+|REVERSE)-\d+)/.exec(planId)?.[1];
    if (short) addAlias(aliases, short, planId);
  }
  const tracked = new Set(paths);
  const pathAliases: Record<string, string[]> = {};
  for (const path of paths) addAlias(pathAliases, basename(path), path);
  const familyMembers = Object.fromEntries(
    [...new Set(familyRefs)].map((family) => [
      family,
      paths.filter((path) => path.startsWith(family) && path !== family),
    ]),
  );
  const catalogPath = "docs/governance/vmodel-document-catalog.md";
  const parsed = parseStrictMarkdownTable(readFileSync(join(repoRoot, catalogPath)), {
    subjectId: catalogPath,
    expectedHeaders: [
      "doc_type_id",
      "layer",
      "sub_doc",
      "category",
      "requirement_class",
      "applicability",
      "default_status",
      "source_doc_family",
      "authoring_source_path",
      "projection_table",
      "profile_controlled",
      "skip_reason_required",
    ],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.findings));
  return Object.freeze({
    aliases: Object.freeze(aliases),
    pathAliases: Object.freeze(pathAliases),
    trackedPaths: tracked,
    familyMembers: Object.freeze(familyMembers),
    targetSlots: new Set(parsed.rows.map((row) => row.doc_type_id)),
  });
}

function trackedPaths(repoRoot: string): string[] {
  return execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"))
    .sort(compareBytes);
}

function addAlias(aliases: Record<string, string[]>, alias: string, canonical: string): void {
  aliases[alias] = [...new Set([...(aliases[alias] ?? []), canonical])].sort(compareBytes);
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
