"use client";

import { useCallback, useEffect, useRef } from "react";

/** Guards delayed popup actions and fallbacks across newer requests/context changes. */
export function useMenuRequest(identity?: string | null) {
  const state = useRef({ generation: 0, identity });
  // Invalidate during render: a native selection can arrive before passive
  // effect cleanup runs for a changed project or session.
  if (state.current.identity !== identity) {
    state.current.identity = identity;
    state.current.generation++;
  }
  useEffect(() => () => { state.current.generation++; }, []);
  return useCallback(() => {
    const request = ++state.current.generation;
    return () => request === state.current.generation;
  }, []);
}
