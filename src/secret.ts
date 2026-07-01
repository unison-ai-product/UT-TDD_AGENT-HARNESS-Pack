/**
 * Secret-like token detector shared by projection, memory, audit, and search guards.
 *
 * Keep this module dependency-free so low-level modules can reuse the same pattern
 * without creating cycles through state-db.
 */
export const SECRET_PATTERN =
  /(\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9_]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\bxox[baprs]-[A-Za-z0-9-]{16,})/;

export function isSecretLike(value: string): boolean {
  return SECRET_PATTERN.test(value);
}
