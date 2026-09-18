import { createHash } from "node:crypto";

type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface PlanAssetError {
  readonly ruleId: string;
  readonly message: string;
}

export interface PlanRevisionInput {
  readonly assetId: string;
  readonly revision: number;
  readonly alias: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly bodyDigest: string;
  readonly actor: string;
  readonly reason: string;
}

export class PlanRevision {
  readonly assetId!: string;
  readonly revision!: number;
  readonly alias!: string;
  readonly payload!: Readonly<Record<string, unknown>>;
  readonly bodyDigest!: string;
  readonly contentDigest!: string;
  readonly actor!: string;
  readonly reason!: string;

  private constructor(input: PlanRevisionInput & { contentDigest: string }) {
    Object.assign(this, input);
    Object.freeze(this);
  }

  static create(input: PlanRevisionInput): Result<PlanRevision, PlanAssetError> {
    if (!validAssetId(input.assetId)) return failed("plan-asset-invalid-id", input.assetId);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      return failed("plan-revision-invalid", String(input.revision));
    }
    if (
      !input.alias.trim() ||
      !isDigest(input.bodyDigest) ||
      !input.actor.trim() ||
      !input.reason.trim()
    ) {
      return failed("plan-revision-invalid", input.alias);
    }
    const payload = deepFreeze(structuredClone(input.payload));
    return {
      ok: true,
      value: new PlanRevision({
        ...input,
        payload,
        contentDigest: hashCanonical({ alias: input.alias, bodyDigest: input.bodyDigest, payload }),
      }),
    };
  }
}

export class PlanAsset {
  readonly assetId: string;
  readonly revisions: readonly PlanRevision[];

  private constructor(assetId: string, revisions: readonly PlanRevision[]) {
    this.assetId = assetId;
    this.revisions = revisions;
    Object.freeze(this);
  }

  get latest(): PlanRevision {
    return this.revisions[this.revisions.length - 1];
  }

  static create(input: {
    assetId: string;
    alias: string;
    payload: Readonly<Record<string, unknown>>;
    bodyDigest: string;
  }): Result<PlanAsset, PlanAssetError> {
    const revision = PlanRevision.create({
      ...input,
      revision: 1,
      actor: "create",
      reason: "initial",
    });
    return revision.ok
      ? { ok: true, value: new PlanAsset(input.assetId, Object.freeze([revision.value])) }
      : revision;
  }

  static reconstruct(revisions: readonly PlanRevision[]): Result<PlanAsset, PlanAssetError> {
    if (revisions.length === 0) return failed("plan-revision-gap", "empty");
    const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
    const assetId = ordered[0].assetId;
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index].assetId !== assetId || ordered[index].revision !== index + 1) {
        return failed("plan-revision-gap", `${assetId}:${index + 1}`);
      }
    }
    return { ok: true, value: new PlanAsset(assetId, Object.freeze(ordered)) };
  }

  revise(input: {
    baseRevision: number;
    alias: string;
    payload: Readonly<Record<string, unknown>>;
    bodyDigest: string;
    actor: string;
    reason: string;
  }): Result<{ asset: PlanAsset; event: Readonly<Record<string, unknown>> }, PlanAssetError> {
    if (input.baseRevision !== this.latest.revision) {
      return failed("plan-revision-stale", `${input.baseRevision}:${this.latest.revision}`);
    }
    const next = PlanRevision.create({
      ...input,
      assetId: this.assetId,
      revision: this.latest.revision + 1,
    });
    if (!next.ok) return next;
    const asset = new PlanAsset(this.assetId, Object.freeze([...this.revisions, next.value]));
    return {
      ok: true,
      value: {
        asset,
        event: Object.freeze({
          ruleId: "plan-revision-added",
          assetId: this.assetId,
          revision: next.value.revision,
          contentDigest: next.value.contentDigest,
        }),
      },
    };
  }
}

function validAssetId(value: string): boolean {
  return /^plan:(?:legacy:)?[a-z0-9][a-z0-9:-]{2,127}$/.test(value);
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
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

function failed(ruleId: string, message: string): { ok: false; error: PlanAssetError } {
  return { ok: false, error: { ruleId, message } };
}
