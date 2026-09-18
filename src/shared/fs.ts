import type { MakeDirectoryOptions } from "node:fs";
import { existsSync, mkdirSync, statSync } from "node:fs";

export function ensureDir(path: string, options?: MakeDirectoryOptions): void {
  try {
    mkdirSync(path, options);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") throw err;
    if (!existsSync(path)) throw err;
    if (!statSync(path).isDirectory()) throw err;
  }
}
