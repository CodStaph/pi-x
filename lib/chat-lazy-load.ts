export const VISIBLE_PAGE_SIZE = 50;
export const CHAT_SCROLL_TAIL_TOLERANCE = 8;
export const CHAT_SCROLL_REATTACH_TOLERANCE = 96;

export function getVisibleRenderWindow(totalCount: number, visibleCount: number): {
  startIndex: number;
  hasMore: boolean;
} {
  const clampedVisibleCount = Math.min(Math.max(visibleCount, 0), Math.max(totalCount, 0));
  const startIndex = Math.max(0, totalCount - clampedVisibleCount);
  return { startIndex, hasMore: startIndex > 0 };
}

export function getNextVisibleCount(currentVisibleCount: number, pageSize = VISIBLE_PAGE_SIZE): number {
  return currentVisibleCount + pageSize;
}

/**
 * A tail refresh (agent_end, an appended entry) returns only the newest page.
 * Replacing the loaded window with it drops the history the reader already
 * paged in: the content above shrinks and the browser clamps the scroll
 * offset, so the conversation appears to jump. Keep the loaded prefix and swap
 * in the new tail, but only when the new page overlaps the loaded window;
 * otherwise the page belongs to another branch and replaces it.
 */
export function mergeTailWindow<T>(
  previousEntryIds: readonly string[],
  previousMessages: readonly T[],
  nextEntryIds: readonly string[],
  nextMessages: readonly T[],
): { entryIds: string[]; messages: T[]; keptPrefix: number } {
  if (!nextEntryIds.length || previousEntryIds.length <= nextEntryIds.length) {
    return { entryIds: [...nextEntryIds], messages: [...nextMessages], keptPrefix: 0 };
  }
  const firstNext = nextEntryIds[0];
  const cut = previousEntryIds.indexOf(firstNext);
  if (cut <= 0) {
    return { entryIds: [...nextEntryIds], messages: [...nextMessages], keptPrefix: 0 };
  }
  return {
    entryIds: [...previousEntryIds.slice(0, cut), ...nextEntryIds],
    messages: [...previousMessages.slice(0, cut), ...nextMessages],
    keptPrefix: cut,
  };
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}

export function isScrollAtTail(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

export function getLiveFollowAttached(
  wasAttached: boolean,
  previousScrollTop: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  reattachTolerance = CHAT_SCROLL_REATTACH_TOLERANCE,
): boolean {
  if (isScrollAtTail(scrollTop, clientHeight, scrollHeight)) return true;
  if (scrollTop < previousScrollTop) return false;
  if (
    !wasAttached
    && scrollTop > previousScrollTop
    && isScrollAtTail(scrollTop, clientHeight, scrollHeight, reattachTolerance)
  ) return true;
  return wasAttached;
}

export function shouldShowScrollToLatest(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  if (scrollHeight <= clientHeight) return false;
  return !isScrollAtTail(scrollTop, clientHeight, scrollHeight, tolerance);
}

export function getPromptAnchorSpacerHeight(
  targetTop: number,
  contentEnd: number,
  clientHeight: number,
): number {
  const clampedTargetTop = Math.max(0, targetTop);
  if (clampedTargetTop === 0) return 0;

  return Math.max(0, Math.ceil(
    clampedTargetTop + clientHeight - Math.max(0, contentEnd),
  ));
}
