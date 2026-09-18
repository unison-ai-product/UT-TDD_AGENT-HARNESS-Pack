import { createHash } from "node:crypto";

export function stableId(prefix: string, value: string): string {
  const raw = value || "unknown";
  const sanitized = raw.replace(/[^A-Za-z0-9._:-]+/g, "-");
  if (sanitized === raw && sanitized !== "") return `${prefix}:${sanitized}`;
  const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${prefix}:${sanitized || "unknown"}--${suffix}`;
}
