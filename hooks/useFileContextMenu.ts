"use client";

import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { showNativeMenu } from "@/lib/desktop-menu";
import { openDomMenu } from "@/lib/dom-menu-store";
import { isTauriDesktop } from "@/lib/desktop-updater";
import {
  listAppsForFileNative,
  openPathNative,
  openPathWithNative,
  revealItemInDirNative,
  selectApplicationNative,
  type FileOpenApp,
} from "@/lib/desktop-native";
import { getDesktopPlatform } from "@/lib/desktop-window";
import { appListCacheKey, buildFileMenuEntries, revealLabelKey } from "@/lib/file-context-menu";
import { encodeFilePathForApi } from "@/lib/file-paths";

const APP_LIST_TTL_MS = 5 * 60_000;
/** Past this the menu opens without the app list rather than keep the user waiting. */
const APP_LIST_WAIT_MS = 800;

const appListCache = new Map<string, { apps: FileOpenApp[]; at: number }>();

async function loadApps(filePath: string): Promise<FileOpenApp[]> {
  const key = appListCacheKey(filePath);
  const cached = appListCache.get(key);
  if (cached && Date.now() - cached.at < APP_LIST_TTL_MS) return cached.apps;
  const apps = await listAppsForFileNative(filePath);
  appListCache.set(key, { apps, at: Date.now() });
  return apps;
}

async function loadAppsWithinDeadline(filePath: string): Promise<FileOpenApp[]> {
  const slow = new Promise<FileOpenApp[]>((resolve) => setTimeout(() => resolve([]), APP_LIST_WAIT_MS));
  try {
    return await Promise.race([loadApps(filePath), slow]);
  } catch {
    return [];
  }
}

export interface FileMenuTarget { filePath: string; page?: number; verify?: boolean }

/** Desktop-only; the browser retains its own context menu. */
export function useFileContextMenu(onOpenFile?: (filePath: string, page?: number) => void) {
  const { t } = useI18n();
  const generation = useRef(0);
  const context = useRef({ onOpenFile, t });
  if (context.current.onOpenFile !== onOpenFile || context.current.t !== t) {
    context.current = { onOpenFile, t };
    generation.current++;
  }
  useEffect(() => () => { generation.current++; }, []);
  return useCallback((event: MouseEvent, { filePath, page, verify }: FileMenuTarget) => {
    if (!isTauriDesktop()) return;
    event.preventDefault();
    event.stopPropagation();
    const at = { x: event.clientX, y: event.clientY };
    const request = ++generation.current;
    const report = (error: unknown) => console.error("[file-menu] action failed", error);
    void (async () => {
      if (verify) {
        const response = await fetch(`/api/files/${encodeFilePathForApi(filePath)}?type=meta`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return;
      }
      if (request !== generation.current) return;
      const platform = getDesktopPlatform();
      // Finder's "Open With" list only exists on macOS; every lookup costs ~150ms.
      const apps = platform === "macos" ? await loadAppsWithinDeadline(filePath) : null;
      if (request !== generation.current) return;
      const openWith = (appPath: string) => {
        if (request !== generation.current) return;
        return openPathWithNative(filePath, appPath).catch(report);
      };
      const entries = buildFileMenuEntries({
        open: t("fileMenu.open"),
        openWith: t("fileMenu.openWith"),
        otherApp: t("fileMenu.otherApp"),
        reveal: t(revealLabelKey(platform)),
        copyPath: t("fileMenu.copyPath"),
        defaultApp: (name) => t("fileMenu.defaultApp", { name }),
      }, {
        open: () => {
          if (request !== generation.current) return;
          if (onOpenFile) return onOpenFile(filePath, page);
          return openPathNative(filePath);
        },
        openWith,
        chooseOtherApp: () => {
          if (request !== generation.current) return;
          return selectApplicationNative()
            .then((appPath) => { if (appPath) openWith(appPath); })
            .catch(report);
        },
        reveal: () => { if (request === generation.current) return revealItemInDirNative(filePath); },
        copyPath: () => { if (request === generation.current) return copyText(filePath); },
      }, apps);
      if (!(await showNativeMenu(entries, at)) && request === generation.current) openDomMenu(entries, at);
    })().catch(report);
  }, [onOpenFile, t]);
}
