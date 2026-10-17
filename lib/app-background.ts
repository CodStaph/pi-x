"use client";

/**
 * Window background image: a user-chosen picture painted behind the whole
 * workspace, with readability controls (dim / blur / fit).
 *
 * Storage is deliberately client-local (localStorage via app-prefs) so it
 * works identically in the browser build and the packaged desktop WebView
 * without a server route or an agent-dir file. Picked images are re-encoded
 * on a canvas to a bounded JPEG data URL before they are stored, because
 * localStorage has a small quota and a raw camera photo would blow it.
 *
 * A module-level store keeps every consumer (AppShell, SettingsPanel) in
 * sync, mirroring `hooks/useTheme.ts`. The inline boot script in
 * `lib/theme.ts` applies the same state before first paint so no flash of
 * the default canvas is visible on reload.
 */

import { APP_PREF_KEYS, getPref, setPref } from "@/lib/app-prefs";
import {
  isTauriDesktop,
  readDesktopImageAttachments,
  selectFilesNative,
} from "@/lib/desktop-native";

export type AppBackgroundFit = "cover" | "contain";

export type AppBackgroundOptions = {
  enabled: boolean;
  /** 0–0.85; the tint laid over the image to keep text readable. */
  dim: number;
  /** 0–24 px. */
  blur: number;
  fit: AppBackgroundFit;
};

export type AppBackgroundState = {
  image: string | null;
  options: AppBackgroundOptions;
};

export const DEFAULT_APP_BACKGROUND_OPTIONS: AppBackgroundOptions = {
  enabled: true,
  dim: 0.32,
  blur: 0,
  fit: "cover",
};

export const MAX_APP_BACKGROUND_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_APP_BACKGROUND_DIMENSION = 2560;

export const BACKGROUND_IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
  "bmp",
];

const SERVER_SNAPSHOT: AppBackgroundState = {
  image: null,
  options: DEFAULT_APP_BACKGROUND_OPTIONS,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function readOptions(): AppBackgroundOptions {
  const raw = getPref(APP_PREF_KEYS.backgroundImageOptions);
  if (!raw) return { ...DEFAULT_APP_BACKGROUND_OPTIONS };
  try {
    const parsed = JSON.parse(raw) as Partial<AppBackgroundOptions>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      dim: clampNumber(parsed.dim, 0, 0.85, DEFAULT_APP_BACKGROUND_OPTIONS.dim),
      blur: clampNumber(parsed.blur, 0, 24, DEFAULT_APP_BACKGROUND_OPTIONS.blur),
      fit: parsed.fit === "contain" ? "contain" : "cover",
    };
  } catch {
    return { ...DEFAULT_APP_BACKGROUND_OPTIONS };
  }
}

function readImage(): string | null {
  const value = getPref(APP_PREF_KEYS.backgroundImage);
  return value && value.startsWith("data:image/") ? value : null;
}

let snapshot: AppBackgroundState | null = null;
const listeners = new Set<() => void>();

export function getAppBackgroundSnapshot(): AppBackgroundState {
  if (!snapshot) snapshot = { image: readImage(), options: readOptions() };
  return snapshot;
}

export function getAppBackgroundServerSnapshot(): AppBackgroundState {
  return SERVER_SNAPSHOT;
}

export function subscribeAppBackground(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

function commit(next: AppBackgroundState): void {
  snapshot = next;
  applyAppBackgroundToDom(next);
  emit();
}

/**
 * Project the store onto the root element's CSS variables and the
 * `has-app-background` class. Safe to call before hydration (guards on
 * `document`).
 */
export function applyAppBackgroundToDom(state = getAppBackgroundSnapshot()): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const active = state.options.enabled && state.image !== null;
  root.classList.toggle("has-app-background", active);
  if (state.image) {
    // The data URL is base64/percent-encoded image bytes; it never contains a
    // quote, so it is safe to interpolate into `url("...")`.
    root.style.setProperty("--app-bg-image", `url("${state.image}")`);
  } else {
    root.style.removeProperty("--app-bg-image");
  }
  root.style.setProperty("--app-bg-dim", `${Math.round(state.options.dim * 1000) / 10}%`);
  root.style.setProperty("--app-bg-blur", `${state.options.blur}px`);
  root.style.setProperty("--app-bg-size", state.options.fit);
}

/**
 * Store a new data URL, or clear the image with `null`. Throws when the
 * value does not fit the localStorage quota so the caller can report it.
 */
export function setAppBackgroundImage(dataUrl: string | null): void {
  if (typeof window === "undefined") return;
  const options = getAppBackgroundSnapshot().options;
  try {
    if (dataUrl) window.localStorage.setItem(APP_PREF_KEYS.backgroundImage, dataUrl);
    else window.localStorage.removeItem(APP_PREF_KEYS.backgroundImage);
  } catch {
    throw new Error("background-image-too-large");
  }
  commit({ image: dataUrl, options });
}

export function updateAppBackgroundOptions(patch: Partial<AppBackgroundOptions>): void {
  const current = getAppBackgroundSnapshot();
  const options: AppBackgroundOptions = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.options.enabled,
    dim: clampNumber(patch.dim, 0, 0.85, current.options.dim),
    blur: clampNumber(patch.blur, 0, 24, current.options.blur),
    fit: patch.fit === "contain" ? "contain" : patch.fit === "cover" ? "cover" : current.options.fit,
  };
  setPref(APP_PREF_KEYS.backgroundImageOptions, JSON.stringify(options));
  commit({ image: current.image, options });
}

function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  return Math.floor((dataUrl.length - comma - 1) * 0.75);
}

type Drawable = CanvasImageSource & { width: number; height: number };

async function loadDrawable(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // fall through to the <img> path (e.g. SVG, some AVIF builds)
    }
  }
  return await new Promise<Drawable>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("background-image-decode-failed"));
    };
    image.src = url;
  });
}

/** Re-encode a picked image to a bounded JPEG data URL. */
export async function prepareBackgroundImageDataUrl(file: File): Promise<string> {
  const drawable = await loadDrawable(file);
  const width = drawable.width;
  const height = drawable.height;
  if (!width || !height) throw new Error("background-image-decode-failed");

  const dimensions = [MAX_APP_BACKGROUND_DIMENSION, 2048, 1600, 1280, 960];
  const qualities = [0.85, 0.72, 0.6, 0.45];
  let best: string | null = null;

  for (const dimension of dimensions) {
    const scale = Math.min(1, dimension / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("background-image-canvas-unavailable");
    context.drawImage(drawable, 0, 0, canvas.width, canvas.height);
    for (const quality of qualities) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      best = dataUrl;
      if (estimateDataUrlBytes(dataUrl) <= MAX_APP_BACKGROUND_IMAGE_BYTES) return dataUrl;
    }
  }

  if (!best) throw new Error("background-image-encode-failed");
  return best;
}

/**
 * Ask the user for an image. Uses the native dialog on desktop (reading the
 * picked path through the token-guarded images route) and a file input on
 * the web. Resolves null when the picker is cancelled.
 */
export async function pickBackgroundImageFile(): Promise<File | null> {
  if (isTauriDesktop()) {
    const paths = await selectFilesNative({
      multiple: false,
      title: "Background image",
      filters: [{ name: "Images", extensions: BACKGROUND_IMAGE_EXTENSIONS }],
    });
    if (paths.length === 0) return null;
    const [attachment] = await readDesktopImageAttachments(paths);
    if (!attachment) throw new Error("background-image-read-failed");
    const binary = atob(attachment.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  }

  return await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    const cleanup = () => {
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      input.remove();
    };
    const onChange = () => {
      const file = input.files?.[0] ?? null;
      cleanup();
      resolve(file);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    document.body.appendChild(input);
    input.click();
  });
}
