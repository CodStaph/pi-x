import { lstat, readdir, realpath, stat } from "fs/promises";
import path from "path";
import { isPermissionError } from "./directory-browser";
import { hasParentDirectorySegment, isPathWithinRoots } from "./path-security";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";

/**
 * Whether a workspace the UI already knows (a session cwd, a project root, a
 * folder picked earlier) can still host a run. A workspace deleted outside the
 * app keeps its session history, but every cwd-scoped request then fails —
 * `/api/models` with "Directory does not exist", trust, worktrees and files
 * with "Access denied" — which reads as a model or permission problem (#1061).
 */
export type WorkspaceAvailability = "available" | "missing" | "not-directory" | "unreadable";

/** A workspace the UI knows is gone or unusable, for the composer notice. */
export interface UnavailableWorkspace {
  cwd: string;
  availability: Exclude<WorkspaceAvailability, "available">;
}

export type WorkspaceStatusResult =
  | { ok: true; availability: WorkspaceAvailability }
  | { ok: false };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Classifies `cwd` on disk. Callers must authorize the path first. */
export async function readWorkspaceAvailability(cwd: string): Promise<WorkspaceAvailability> {
  let info;
  try {
    info = await stat(cwd);
  } catch (error) {
    if (isPermissionError(error)) return "unreadable";
    const code = errorCode(error);
    // ENOTDIR: a parent component became a file, so the folder is gone all the same.
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    return "unreadable";
  }
  if (!info.isDirectory()) return "not-directory";
  try {
    await readdir(cwd);
  } catch {
    return "unreadable";
  }
  return "available";
}

/** Resolve links in the existing prefix without requiring the deleted tail. */
async function resolveExistingPrefix(target: string): Promise<string | null> {
  let prefix = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(prefix), path.relative(prefix, target));
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") return null;
      try {
        // A dangling link is not a deleted directory. Its destination cannot
        // be authorized, so never reconstruct it as a plain missing segment.
        if ((await lstat(prefix)).isSymbolicLink()) return null;
      } catch (error) {
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") return null;
      }
      const parent = path.dirname(prefix);
      if (parent === prefix) return null;
      prefix = parent;
    }
  }
}

/**
 * The status of `cwd`, or `{ ok: false }` when it is not a workspace the
 * caller may ask about. Lexical authorization precedes filesystem access, and
 * resolved authorization precedes returning any status, so the answer never
 * reveals whether an arbitrary path exists: the path must lie
 * inside the allowed roots lexically, and resolve inside them. For deleted
 * folders, resolve the existing prefixes of both the target and roots so an
 * escaping link cannot expose even the existence of an outside child.
 */
export async function getWorkspaceStatus(cwd: string, allowedRoots: Set<string>): Promise<WorkspaceStatusResult> {
  if (hasParentDirectorySegment(cwd) || !isFilePathAllowed(cwd, allowedRoots)) return { ok: false };
  const availability = await readWorkspaceAvailability(cwd);
  if (availability === "missing") {
    const resolvedTarget = await resolveExistingPrefix(cwd);
    if (!resolvedTarget) return { ok: false };
    const roots = await Promise.all([...allowedRoots].map(resolveExistingPrefix));
    const resolvedRoots = new Set(roots.filter((root): root is string => root !== null));
    if (!isPathWithinRoots(resolvedTarget, resolvedRoots)) return { ok: false };
  } else if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { ok: false };
  }
  return { ok: true, availability };
}
