/**
 * The one place this app converts SDK or on-disk entries into its own
 * `SessionEntry` model.
 *
 * `SessionManager.getEntries()` is typed by the SDK, while `lib/types.ts` keeps
 * a hand-written mirror so the UI never imports SDK types. The two models differ
 * only in detail (the SDK can gain entry kinds before the mirror does), and every
 * conversion used to be an inline `as unknown as SessionEntry[]` at a call site —
 * 14 of them, in five files, which is why a new consumer could quietly invent a
 * fifteenth assertion with a different assumption.
 *
 * Two rules keep this safe:
 *
 *   - `toSessionEntries()` performs the cast and **keeps every entry**. Filtering
 *     to the kinds the mirror knows would drop an SDK entry this app has not
 *     modelled yet, and those flow through `readSessionToolSelection`,
 *     `getUsageCostBreakdown` and the tree walkers harmlessly today.
 *   - `isSessionEntry()` therefore only requires what every entry has: an object
 *     with a string `type`. That is exactly enough to reject a JSONL line that is
 *     not an entry (a header, a truncated tail, `null`) without second-guessing
 *     the SDK.
 */

import type { SessionEntry } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value has the shape every session entry shares. */
export function isSessionEntry(value: unknown): value is SessionEntry {
  return isRecord(value) && typeof value.type === "string";
}

/** `value` as a session entry, or `null` when it is not one. */
export function toSessionEntry(value: unknown): SessionEntry | null {
  return isSessionEntry(value) ? value : null;
}

/**
 * The single cast from the SDK's entry type to this app's mirror.
 *
 * Entries are passed through untouched — see the module comment for why.
 */
export function toSessionEntries(entries: readonly unknown[]): SessionEntry[] {
  return entries as unknown as SessionEntry[];
}

/**
 * Tolerant JSONL parsing for a session file's entries: a malformed line (a
 * truncated tail written while the file was read) is skipped, never thrown.
 */
export function parseSessionEntryLines(lines: readonly string[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = toSessionEntry(JSON.parse(trimmed));
      if (entry) entries.push(entry);
    } catch {
      // A partial last line is expected on a file being appended to.
    }
  }
  return entries;
}
