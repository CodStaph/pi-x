/**
 * In-memory stash for unsaved editor drafts. The file viewer unmounts when its
 * tab is not active, so without this a switch to another tab (or session) would
 * silently drop the edit. Keyed by absolute path; not persisted, so a page
 * reload still loses drafts (the editor warns before that with beforeunload).
 */
export interface FileDraft {
  content: string;
  baseMtimeMs?: number;
  updatedAt: number;
}

const MAX_DRAFTS = 20;
const drafts = new Map<string, FileDraft>();

export function getFileDraft(filePath: string): FileDraft | undefined {
  return drafts.get(filePath);
}

export function setFileDraft(filePath: string, content: string, baseMtimeMs?: number): void {
  // Re-insert so the most recently touched draft is also the most recent entry.
  drafts.delete(filePath);
  drafts.set(filePath, { content, baseMtimeMs, updatedAt: Date.now() });
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

export function clearFileDraft(filePath: string): void {
  drafts.delete(filePath);
}

export function clearAllFileDrafts(): void {
  drafts.clear();
}
