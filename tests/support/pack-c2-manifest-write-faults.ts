import { join } from "node:path";

export type WriteFault = "open" | "write" | "close" | "unlink";
export const PACK_ROOT = join("scratch", "pack");
export const RELEASE_DIR = join(PACK_ROOT, "release");
export const MANIFEST_PATH = join(RELEASE_DIR, "manifest.yaml");
export const KEEP_PATH = join(RELEASE_DIR, "keep.txt");
export const CONCURRENT_PATH = join(RELEASE_DIR, "concurrent.txt");

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function createWriteFaultPorts(fault: WriteFault, preexistingRelease: boolean) {
  const files = new Map<string, Buffer>();
  const dirs = new Set(preexistingRelease ? [RELEASE_DIR] : []);
  if (preexistingRelease) files.set(KEEP_PATH, Buffer.from("keep\n"));
  const operations: string[] = [];
  const fs = {
    mkdir(path: string) {
      operations.push("mkdir");
      if (dirs.has(path)) throw fsError("EEXIST", "directory exists");
      dirs.add(path);
    },
    open(path: string, flags: string) {
      operations.push(`open:${flags}`);
      if (fault === "open") {
        if (preexistingRelease) files.set(MANIFEST_PATH, Buffer.from("other manifest\n"));
        throw fsError("EACCES", "open denied");
      }
      if (files.has(path)) throw fsError("EEXIST", "file exists");
      files.set(path, Buffer.alloc(0));
      return path;
    },
    write(path: string, bytes: Uint8Array) {
      operations.push("write");
      if (fault === "write" || fault === "unlink") {
        files.set(path, Buffer.from("partial"));
        if (preexistingRelease) files.set(CONCURRENT_PATH, Buffer.from("other\n"));
        throw fsError("EIO", "write failed");
      }
      files.set(path, Buffer.from(bytes));
    },
    close(_path: string) {
      operations.push("close");
      if (fault === "close") throw fsError("EIO", "close failed");
    },
    unlink(path: string) {
      operations.push("unlink");
      if (fault === "unlink") throw fsError("EACCES", "unlink denied");
      files.delete(path);
    },
    rmdir(path: string) {
      operations.push("rmdir");
      if (files.size > 0) throw fsError("ENOTEMPTY", "directory is not empty");
      dirs.delete(path);
    },
  };
  return { fs, files, dirs, operations };
}
