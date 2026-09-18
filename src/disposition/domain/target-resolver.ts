export type TargetKind = "plan_alias" | "artifact_path" | "artifact_family" | "target_slot";

export interface TypedTarget {
  readonly kind: TargetKind;
  readonly ref: string;
}

export interface TargetRegistry {
  readonly aliases: Readonly<Record<string, readonly string[]>>;
  readonly pathAliases: Readonly<Record<string, readonly string[]>>;
  readonly trackedPaths: ReadonlySet<string>;
  readonly familyMembers: Readonly<Record<string, readonly string[]>>;
  readonly targetSlots: ReadonlySet<string>;
}

export interface TargetFinding {
  readonly ruleId:
    | "target-unresolved"
    | "target-ambiguous"
    | "target-existence-missing"
    | "target-canonical-mismatch";
  readonly subjectId: string;
  readonly message: string;
}

export interface CanonicalTarget {
  readonly kind: TargetKind;
  readonly canonicalRefs: readonly string[];
}

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly findings: readonly TargetFinding[] };

export function resolveCanonicalTarget(
  target: TypedTarget,
  registry: TargetRegistry,
): Result<CanonicalTarget> {
  const refs = resolveRefs(target, registry);
  if (!refs.ok) return refs;
  return {
    ok: true,
    value: Object.freeze({ kind: target.kind, canonicalRefs: Object.freeze(refs.value) }),
  };
}

export function reconcileDispositionTarget(
  input: { readonly displayRef: string; readonly edge: TypedTarget },
  registry: TargetRegistry,
): Result<readonly string[]> {
  const edge = resolveCanonicalTarget(input.edge, registry);
  if (!edge.ok) return edge;
  const display = resolveCanonicalTarget(
    { kind: input.edge.kind, ref: input.displayRef },
    registry,
  );
  if (!display.ok || !sameRefs(edge.value.canonicalRefs, display.value.canonicalRefs)) {
    return failed("target-canonical-mismatch", input.displayRef);
  }
  return { ok: true, value: edge.value.canonicalRefs };
}

function resolveRefs(target: TypedTarget, registry: TargetRegistry): Result<string[]> {
  switch (target.kind) {
    case "plan_alias":
      return resolveAlias(target.ref, registry.aliases);
    case "artifact_path":
      if (registry.trackedPaths.has(target.ref)) return success([target.ref]);
      return resolvePathAlias(target.ref, registry.pathAliases);
    case "artifact_family":
      return resolveFamily(target.ref, registry);
    case "target_slot":
      return registry.targetSlots.has(target.ref)
        ? success([target.ref])
        : failed("target-existence-missing", target.ref);
  }
}

function resolvePathAlias(ref: string, aliases: TargetRegistry["pathAliases"]): Result<string[]> {
  const candidates = uniqueSorted(aliases[ref] ?? []);
  if (candidates.length === 0) return failed("target-existence-missing", ref);
  if (candidates.length > 1) return failed("target-ambiguous", ref);
  return success(candidates);
}

function resolveAlias(ref: string, aliases: TargetRegistry["aliases"]): Result<string[]> {
  const candidates = uniqueSorted(aliases[ref] ?? []);
  if (candidates.length === 0) return failed("target-unresolved", ref);
  if (candidates.length > 1) return failed("target-ambiguous", ref);
  return success(candidates);
}

function resolveFamily(ref: string, registry: TargetRegistry): Result<string[]> {
  const members = uniqueSorted(registry.familyMembers[ref] ?? []);
  if (members.length === 0) return failed("target-unresolved", ref);
  const phantom = members.find((member) => !registry.trackedPaths.has(member));
  if (phantom) return failed("target-existence-missing", phantom);
  return success(members);
}

function success(values: string[]): Result<string[]> {
  return { ok: true, value: uniqueSorted(values) };
}

function failed(ruleId: TargetFinding["ruleId"], subjectId: string): Result<never> {
  return {
    ok: false,
    findings: Object.freeze([
      Object.freeze({ ruleId, subjectId, message: `${ruleId}: ${subjectId}` }),
    ]),
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareBytes);
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
