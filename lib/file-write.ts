import fs from "fs";
import path from "path";

/**
 * Upper bound for an in-place edit. The read endpoint returns 256 KiB chunks
 * and the viewer only offers Edit once the whole file is loaded, so this cap
 * comfortably covers a file loaded through a couple of "Load more" clicks
 * while still refusing to buffer an unbounded request body.
 */
export const MAX_FILE_WRITE_BYTES = 512 * 1024;
const MAX_WRITE_JSON_BYTES = MAX_FILE_WRITE_BYTES * 4 + 1024 * 1024;

export interface WrittenFileStat {
  mtimeMs: number;
  size: number;
}

export class FileWriteConflictError extends Error {
  readonly current: WrittenFileStat;

  constructor(current: WrittenFileStat) {
    super("File changed on disk");
    this.name = "FileWriteConflictError";
    this.current = current;
  }
}

export class FileWriteTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(`File too large to edit (${bytes} bytes)`);
    this.name = "FileWriteTooLargeError";
    this.bytes = bytes;
  }
}

export function maxWriteJsonBytes(): number {
  return MAX_WRITE_JSON_BYTES;
}

/**
 * Replace a regular file's contents atomically: write a sibling temp file and
 * rename it over the target, so a crash mid-write never truncates the original.
 * `baseMtimeMs` is the mtime the caller last read; when the file changed on
 * disk in between (an agent edited it, another window saved it) the write is
 * refused instead of silently clobbering that change.
 */
export function writeTextFileAtomically(
  filePath: string,
  content: string,
  baseMtimeMs?: number,
): WrittenFileStat {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Not a regular file");
  }

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_WRITE_BYTES) throw new FileWriteTooLargeError(bytes);

  if (baseMtimeMs !== undefined && stat.mtimeMs !== baseMtimeMs) {
    throw new FileWriteConflictError({ mtimeMs: stat.mtimeMs, size: stat.size });
  }

  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.pi-web-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: stat.mode & 0o777 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temp file may never have been created, or was already renamed.
    }
    throw error;
  }

  const next = fs.statSync(filePath);
  return { mtimeMs: next.mtimeMs, size: next.size };
}
