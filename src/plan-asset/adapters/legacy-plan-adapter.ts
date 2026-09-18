import { createHash } from "node:crypto";

export { resolveLegacyPlanAlias } from "../../kernel/plan-alias.ts";

type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function adaptLegacyPlan(input: {
  repositoryIdentity: string;
  sourcePath: string;
  legacyPlanId: string;
  knownFrontmatter: Readonly<Record<string, unknown>>;
  unknownFrontmatter: Readonly<Record<string, unknown>>;
  bodyDigest: string;
  sourceCommit: string;
}): Result<
  { assetId: string; canonicalPayload: Readonly<Record<string, unknown>> },
  { ruleId: string }
> {
  if (
    !input.repositoryIdentity.trim() ||
    !input.legacyPlanId.trim() ||
    input.repositoryIdentity !== input.repositoryIdentity.normalize("NFC") ||
    input.legacyPlanId !== input.legacyPlanId.normalize("NFC")
  ) {
    return { ok: false, error: { ruleId: "plan-migration-loss" } };
  }
  const canonicalPayload = deepFreeze(
    structuredClone({
      sourcePath: input.sourcePath,
      legacyPlanId: input.legacyPlanId,
      knownFrontmatter: input.knownFrontmatter,
      unknownFrontmatter: input.unknownFrontmatter,
      bodyDigest: input.bodyDigest,
      sourceCommit: input.sourceCommit,
    }),
  );
  return {
    ok: true,
    value: {
      assetId: deriveLegacyAssetId(input.repositoryIdentity, input.legacyPlanId),
      canonicalPayload,
    },
  };
}

export function deriveLegacyAssetId(repositoryIdentity: string, legacyPlanId: string): string {
  const hash = createHash("sha256");
  for (const value of ["ut-tdd-plan-legacy-v1", repositoryIdentity, legacyPlanId]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return `plan:legacy:${hash.digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
