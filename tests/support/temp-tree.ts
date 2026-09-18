import { rmSync } from "node:fs";

export interface TempTreeCleanupDeps {
  collectGarbage?: () => void;
  remove?: (
    path: string,
    options: {
      recursive: true;
      force: true;
      maxRetries: number;
      retryDelay: number;
    },
  ) => void;
}

export function removeTestTree(path: string, deps: TempTreeCleanupDeps = {}): void {
  (deps.remove ?? rmSync)(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}
