/**
 * 固定チャンク read によるファイル sha256 hash (PLAN-L7-457)。
 *
 * `readFileSync` 丸読みは Bun で 2GiB 超のファイルに対し `ERR_FS_FILE_TOO_LARGE` を投げ、
 * workspace fence (`tests/support/git-workspace-fingerprint.ts`) と snapshot runner
 * (`scripts/run-vitest-snapshot.ts`) の両方でローカル検証を全停止させる (issue #118)。
 * `openSync`/`readSync` ループへ置換し、メモリ使用をチャンク長で有界にする。
 *
 * 意味論不変: 同一ファイルに対し従来の `createHash("sha256").update(readFileSync(path))` と
 * 完全に同一の sha256 hex digest を返す (chunk update と全体 update は暗号学的に同値)。
 */
import { createHash, type Hash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

/** 既定チャンク長 (8MiB)。ファイルサイズに関わらずこの長さでメモリ使用が有界になる。 */
export const DEFAULT_HASH_CHUNK_BYTES = 8 * 1024 * 1024;

/** テスト注入用の低レベル file IO (既定は node:fs の実装)。 */
export interface ChunkedFileIo {
  openSync(path: string, flags: string): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}

const nodeFileIo: ChunkedFileIo = { openSync, readSync, closeSync };

/**
 * 既存の `Hash` インスタンスへファイル内容をチャンク単位で `update` する。
 * 1 回の `readSync` が要求長より少ないバイトしか返さない部分 read でも、
 * 明示的な position を毎回渡して続行するため EOF まで取りこぼさない
 * (U-FSTREAM-2: 部分 read の継続)。
 */
export function updateHashWithFile(
  hash: Hash,
  path: string,
  chunkSize: number = DEFAULT_HASH_CHUNK_BYTES,
  io: ChunkedFileIo = nodeFileIo,
): void {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunk hash size must be a positive integer: ${chunkSize}`);
  }
  const fd = io.openSync(path, "r");
  try {
    const buffer = Buffer.alloc(chunkSize);
    let position = 0;
    for (;;) {
      const bytesRead = io.readSync(fd, buffer, 0, chunkSize, position);
      if (bytesRead <= 0) break;
      hash.update(bytesRead === chunkSize ? buffer : buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    io.closeSync(fd);
  }
}

/**
 * ファイルを固定チャンクで読み sha256 hex digest を返す (`readFileSync` 丸読みの置換)。
 */
export function hashFileChunked(
  path: string,
  chunkSize: number = DEFAULT_HASH_CHUNK_BYTES,
  io: ChunkedFileIo = nodeFileIo,
): string {
  const hash = createHash("sha256");
  updateHashWithFile(hash, path, chunkSize, io);
  return hash.digest("hex");
}

/** 読取失敗を相対パス + サイズ (取得可能なら) + 原因を含むエラーへ wrap する (issue #118 分解 3)。 */
export function wrapFileReadError(
  context: string,
  relativePath: string,
  sizeBytes: number | undefined,
  cause: unknown,
): Error {
  const sizeLabel = typeof sizeBytes === "number" ? `${sizeBytes} bytes` : "size unavailable";
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${context} failed reading ${relativePath} (${sizeLabel}): ${causeMessage}`);
}

/**
 * chunked hash を計算し、失敗時は相対パス/サイズ/原因を含む診断エラーへ wrap して再 throw する。
 */
export function hashFileChunkedWithDiagnostics(
  context: string,
  absolutePath: string,
  relativePath: string,
  sizeBytes: number,
  chunkSize: number = DEFAULT_HASH_CHUNK_BYTES,
  io: ChunkedFileIo = nodeFileIo,
): string {
  try {
    return hashFileChunked(absolutePath, chunkSize, io);
  } catch (cause) {
    throw wrapFileReadError(context, relativePath, sizeBytes, cause);
  }
}
