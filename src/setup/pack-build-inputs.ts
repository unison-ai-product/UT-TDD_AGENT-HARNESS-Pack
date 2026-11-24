/**
 * The tagged-source build inputs of a Pack: files the producer (`distribution package`) reads from
 * the C1 snapshot but that are not Pack artifacts. The one place that selects them
 * (docs/design/harness/L6-function-design/pack-build-inputs.md §3-§4).
 */
export const PACK_BUILD_INPUT_FILES: readonly string[] = [
  "docs/governance/node-toolchain-provenance.json",
  "tsconfig.node.json",
  "docs/governance/vmodel-document-catalog.md",
];

export const PACK_BUILD_INPUT_TEMPLATE_RULE = {
  prefix: "docs/templates/vmodel/",
  suffix: ".md",
  excludePrefix: "docs/templates/vmodel/review-examples/",
};

export type PackBuildInputReason =
  | { code: "pack_build_input_missing" | "pack_build_input_untracked"; path: string }
  | { code: "pack_build_input_template_set_empty" };

export type PackBuildInputSelection =
  | { ok: true; paths: readonly string[] }
  | { ok: false; reasons: readonly PackBuildInputReason[] };

const { prefix, suffix, excludePrefix } = PACK_BUILD_INPUT_TEMPLATE_RULE;

const byPath = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function selectPackBuildInputs(
  treePaths: readonly string[],
  exists?: (path: string) => boolean,
): PackBuildInputSelection {
  const tree = new Set(treePaths.map((path) => path.replaceAll("\\", "/")));
  const templates = [...tree].filter(
    (path) => path.startsWith(prefix) && path.endsWith(suffix) && !path.startsWith(excludePrefix),
  );
  const reasons: PackBuildInputReason[] = PACK_BUILD_INPUT_FILES.filter((path) => !tree.has(path))
    .sort(byPath)
    .map((path) => ({
      code: exists?.(path) ? "pack_build_input_untracked" : "pack_build_input_missing",
      path,
    }));
  if (templates.length === 0) reasons.push({ code: "pack_build_input_template_set_empty" });
  if (reasons.length > 0) return { ok: false, reasons };
  const paths = [...new Set([...PACK_BUILD_INPUT_FILES, ...templates])].sort(byPath);
  return { ok: true, paths };
}
