export const REDACTED_ARGS_SCHEMA = "redacted-argv/v1" as const;

export interface RedactedCommandArgs {
  readonly schemaVersion: typeof REDACTED_ARGS_SCHEMA;
  readonly values: readonly string[];
}

const instances = new WeakSet<object>();

export function createRedactedCommandArgs(values: readonly string[]): RedactedCommandArgs {
  return brand(redact(values));
}

export function restoreRedactedCommandArgs(values: readonly string[]): RedactedCommandArgs | null {
  return JSON.stringify(redact(values)) === JSON.stringify(values) ? brand(values) : null;
}

export function isRedactedCommandArgs(value: unknown): value is RedactedCommandArgs {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    instances.has(value as object) &&
    (value as RedactedCommandArgs).values.every((item) => item.length > 0)
  );
}

export function storedRedactedArgsValid(value: unknown): value is RedactedCommandArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "schemaVersion,values" &&
    record.schemaVersion === REDACTED_ARGS_SCHEMA &&
    Array.isArray(record.values) &&
    record.values.length > 0 &&
    record.values.every((item) => typeof item === "string" && item.length > 0) &&
    JSON.stringify(redact(record.values)) === JSON.stringify(record.values)
  );
}

function redact(values: readonly string[]): readonly string[] {
  const result: string[] = [];
  let redactNext = false;
  let headerNext = false;
  for (const raw of values) {
    const value = String(raw);
    if (redactNext) {
      result.push("[REDACTED]");
      redactNext = false;
    } else if (headerNext) {
      result.push(redactHeader(value));
      headerNext = false;
    } else if (value === "-H" || value === "--header") {
      result.push(value);
      headerNext = true;
    } else if (
      !value.includes("=") &&
      !value.includes(":") &&
      isSensitiveName(value.replace(/^-+/, ""))
    ) {
      result.push(value);
      redactNext = true;
    } else {
      result.push(redactInline(value));
    }
  }
  return result;
}

function redactInline(value: string): string {
  const assignment = value.indexOf("=");
  if (assignment > 0 && isSensitiveName(value.slice(0, assignment).replace(/^-+/, ""))) {
    return `${value.slice(0, assignment + 1)}[REDACTED]`;
  }
  const header = redactHeader(value);
  if (header !== value) return header;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(value)) {
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, "$1[REDACTED]@");
  }
  return value.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
}

function redactHeader(value: string): string {
  const separator = value.indexOf(":");
  if (separator <= 0 || !isSensitiveName(value.slice(0, separator).trim())) return value;
  return `${value.slice(0, separator + 1)} [REDACTED]`;
}

function isSensitiveName(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return /(?:token|secret|password|passphrase|api-?key|client-?key|signing-?key|access-?key|ssh-?key|authorization|authentication|credential|private-key|cookie|session(?:-id)?|x-auth|auth-key)/.test(
    normalized,
  );
}

function brand(values: readonly string[]): RedactedCommandArgs {
  const instance = Object.freeze({
    schemaVersion: REDACTED_ARGS_SCHEMA,
    values: Object.freeze([...values]),
  });
  instances.add(instance);
  return instance;
}
