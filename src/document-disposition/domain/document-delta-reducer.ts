import { canonicalField, sha256 } from "./canonical-frame.ts";
import type { DocumentDelta, DocumentMemberIdentity } from "./document-delta.ts";

const encoder = new TextEncoder();

export function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export const sameMember = (
  left: DocumentMemberIdentity | undefined,
  right: DocumentMemberIdentity | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.path === right.path &&
  left.blobOid === right.blobOid &&
  left.contentDigest === right.contentDigest;

export function duplicatePaths(members: readonly DocumentMemberIdentity[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.path, (counts.get(member.path) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort(compareUtf8);
}

export function caseFoldCollisions(members: readonly DocumentMemberIdentity[]): readonly string[] {
  const groups = new Map<string, Set<string>>();
  for (const member of members) {
    const folded = member.path.normalize("NFC").toLowerCase();
    const group = groups.get(folded) ?? new Set<string>();
    group.add(member.path);
    groups.set(folded, group);
  }
  return [...groups.values()]
    .map((group) => [...group].sort(compareUtf8))
    .filter((group) => group.length > 1)
    .map((group) => group.join("|"))
    .sort(compareUtf8);
}

export const affectedPath = (delta: DocumentDelta): string =>
  delta.kind === "delete" ? delta.before.path : delta.after.path;

export function effectiveReductionDigest(members: readonly DocumentMemberIdentity[]): string {
  return sha256(
    [...members]
      .sort((left, right) => compareUtf8(left.path, right.path))
      .flatMap((member) => [
        canonicalField("path", member.path),
        canonicalField("blob_oid", member.blobOid),
        canonicalField("content_digest", member.contentDigest),
      ]),
  );
}

export function applyDocumentDelta(
  state: Map<string, DocumentMemberIdentity>,
  delta: DocumentDelta,
): string | undefined {
  if (delta.kind === "add") {
    if (state.has(delta.after.path)) return "path-already-exists";
    state.set(delta.after.path, delta.after);
    return;
  }
  const current = state.get(delta.before.path);
  if (!current) return "source-missing";
  if (!sameMember(current, delta.before)) return "stale-before";
  if (delta.kind === "delete") {
    state.delete(delta.before.path);
    return;
  }
  if (delta.kind === "modify" && delta.before.path !== delta.after.path) return "path-changed";
  if (delta.kind === "rename" && delta.before.path === delta.after.path) return "same-path";
  if (delta.kind === "rename" && state.has(delta.after.path)) return "target-exists";
  state.delete(delta.before.path);
  state.set(delta.after.path, delta.after);
}
