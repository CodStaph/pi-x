"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  applyAppBackgroundToDom,
  getAppBackgroundServerSnapshot,
  getAppBackgroundSnapshot,
  setAppBackgroundImage,
  subscribeAppBackground,
  updateAppBackgroundOptions,
} from "@/lib/app-background";

/**
 * Subscribe to the window background-image store and keep the root element's
 * CSS variables in sync. Mounted for its side effects by AppShell; the
 * settings panel also reads it for its controls.
 */
export function useAppBackground() {
  const state = useSyncExternalStore(
    subscribeAppBackground,
    getAppBackgroundSnapshot,
    getAppBackgroundServerSnapshot,
  );

  useEffect(() => {
    applyAppBackgroundToDom(state);
  }, [state]);

  return {
    ...state,
    setImage: setAppBackgroundImage,
    updateOptions: updateAppBackgroundOptions,
  };
}
