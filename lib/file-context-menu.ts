import { resolveLocalFileHref } from "./file-links";
import { getFileName } from "./file-paths";
import type { NativeMenuEntry } from "./desktop-menu-model";
import type { DesktopPlatform } from "./desktop-window";
import type { FileOpenApp } from "./desktop-native";

/** Cheap synchronous filter; existence is checked through the authorised file API. */
export function inlineCodeFilePath(text: string, cwd?: string): string | null {
  const path = text.trim();
  if (!path || path.length > 260 || /[\r\n\t]/.test(path) || path.startsWith("~") || path.includes("://")) return null;
  return resolveLocalFileHref(path, cwd);
}

/** Apps are listed per file type: Launch Services answers by extension, and one lookup costs ~150ms. */
export function appListCacheKey(filePath: string): string {
  const name = getFileName(filePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export type FileMenuLabels = {
  open: string;
  openWith: string;
  otherApp: string;
  reveal: string;
  copyPath: string;
  defaultApp: (name: string) => string;
};

export interface FileMenuActions {
  open: () => void;
  openWith: (appPath: string) => void;
  chooseOtherApp: () => void;
  reveal: () => void;
  copyPath: () => void;
}

/**
 * `apps` is null where the platform has no Open With (everything but macOS), so
 * the submenu is omitted; an empty list still offers "Other...".
 */
export function buildFileMenuEntries(
  labels: FileMenuLabels,
  actions: FileMenuActions,
  apps: FileOpenApp[] | null,
): NativeMenuEntry[] {
  const entries: NativeMenuEntry[] = [{ label: labels.open, onSelect: actions.open }];
  if (apps) {
    entries.push({
      kind: "submenu",
      label: labels.openWith,
      items: [
        ...apps.map((app): NativeMenuEntry => ({
          label: app.isDefault ? labels.defaultApp(app.name) : app.name,
          onSelect: () => actions.openWith(app.path),
        })),
        ...(apps.length > 0 ? [{ kind: "separator" as const }] : []),
        { label: labels.otherApp, onSelect: actions.chooseOtherApp },
      ],
    });
  }
  entries.push(
    { kind: "separator" },
    { label: labels.reveal, onSelect: actions.reveal },
    { label: labels.copyPath, onSelect: actions.copyPath },
  );
  return entries;
}

/** Message key for "reveal in the file manager", named after the platform's own. */
export function revealLabelKey(platform: DesktopPlatform): string {
  if (platform === "macos") return "fileMenu.revealInFinder";
  if (platform === "windows") return "fileMenu.revealInExplorer";
  return "fileMenu.revealInFileManager";
}
