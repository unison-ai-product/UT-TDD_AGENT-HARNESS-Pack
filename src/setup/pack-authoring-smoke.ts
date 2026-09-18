import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { teamDefinitionSchema } from "../schema/team.ts";
import {
  AUTHORING_TEMPLATE_ARTIFACT_PATHS,
  validateAuthoringArtifactSet,
} from "./authoring-template-inventory.ts";

export interface PackAuthoringSmokeEntry {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly content: Uint8Array;
}

export interface PackAuthoringSmokeResult {
  readonly ok: boolean;
  readonly checked: readonly string[];
  readonly errors: readonly string[];
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Pack-only authoring smoke. The input is already a materialized Pack tree, so no source path,
 * worktree, Pack checkout, runtime state, or remote adapter is consulted.
 */
export function inspectPackAuthoringEntries(
  entries: readonly PackAuthoringSmokeEntry[],
): PackAuthoringSmokeResult {
  const inventory = validateAuthoringArtifactSet(entries.map((entry) => entry.path));
  const errors: string[] = [];
  if (!inventory.ok) {
    errors.push(
      ...inventory.missingArtifactPaths.map((path) => `missing:${path}`),
      ...inventory.duplicateArtifactPaths.map((path) => `duplicate:${path}`),
      ...inventory.unknownArtifactPaths.map((path) => `unknown:${path}`),
      ...inventory.sourcePaths.map((path) => `source-path:${path}`),
    );
  }
  const byPath = new Map<string, PackAuthoringSmokeEntry>();
  for (const entry of entries) {
    if (AUTHORING_TEMPLATE_ARTIFACT_PATHS.includes(entry.path)) byPath.set(entry.path, entry);
  }
  for (const path of AUTHORING_TEMPLATE_ARTIFACT_PATHS) {
    const entry = byPath.get(path);
    if (!entry) continue;
    if (entry.mode !== "100644") errors.push(`mode:${path}`);
    try {
      const text = decoder.decode(entry.content);
      if (text.includes("\r")) errors.push(`line-ending:${path}`);
      if (path === "docs/templates/state/vmodel.json") JSON.parse(text);
      if (path === "docs/templates/team/example-review-team.yaml")
        teamDefinitionSchema.parse(parseYaml(text));
    } catch {
      errors.push(`parse:${path}`);
    }
  }
  return Object.freeze({
    ok: errors.length === 0,
    checked: Object.freeze([...AUTHORING_TEMPLATE_ARTIFACT_PATHS]),
    errors: Object.freeze([...new Set(errors)].sort()),
  });
}

export function runPackAuthoringSmoke(root: string): PackAuthoringSmokeResult {
  const entries: PackAuthoringSmokeEntry[] = [];
  try {
    for (const path of AUTHORING_TEMPLATE_ARTIFACT_PATHS) {
      const fullPath = join(root, ...path.split("/"));
      const stat = lstatSync(fullPath);
      entries.push({
        path,
        mode: stat.isSymbolicLink() || (stat.mode & 0o111) !== 0 ? "100755" : "100644",
        content: stat.isSymbolicLink() ? new Uint8Array() : readFileSync(fullPath),
      });
    }
  } catch (error) {
    return {
      ok: false,
      checked: Object.freeze(entries.map((entry) => entry.path)),
      errors: Object.freeze([`read:${error instanceof Error ? error.message : String(error)}`]),
    };
  }
  return inspectPackAuthoringEntries(entries);
}
