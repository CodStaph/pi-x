import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LocalizedOutputLocale } from "./api-types";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * Settings › Chat's "localized output" switch. pi's resource loader appends the
 * global `<agentDir>/APPEND_SYSTEM.md` to every session's system prompt
 * (`discoverAppendSystemPromptFile` in the SDK), so writing a managed block
 * there makes every session answer in the language picked in the interface.
 *
 * Only the block between the markers belongs to this setting: whatever the
 * operator already wrote in that file survives each write, and switching off
 * removes just the block. The file is ignored in a trusted project that ships
 * its own `.pi/APPEND_SYSTEM.md`, which pi prefers over the global one.
 */

const BEGIN_MARKER = "<!-- pi-web:localized-output:begin";
const END_MARKER = "<!-- pi-web:localized-output:end -->";
/** The whole managed block, from its begin marker to its end marker. */
const BLOCK_PATTERN = /<!-- pi-web:localized-output:begin[\s\S]*?<!-- pi-web:localized-output:end -->/;
/** The locale token this setting wrote into the begin marker, when present. */
const LOCALE_IN_BEGIN = /<!-- pi-web:localized-output:begin\s+(\S+?)\s*-->/;

const LANGUAGE_NAMES: Record<LocalizedOutputLocale, string> = {
  "en": "English",
  "zh-CN": "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
};

export function isLocalizedOutputLocale(value: unknown): value is LocalizedOutputLocale {
  return value === "en" || value === "zh-CN" || value === "zh-TW";
}

/** The global file pi appends to every system prompt. */
export function getAppendSystemPromptPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "APPEND_SYSTEM.md");
}

/** The managed block, markers included. */
export function localizedOutputBlock(locale: LocalizedOutputLocale): string {
  return [
    `${BEGIN_MARKER} ${locale} -->`,
    `Always answer in ${LANGUAGE_NAMES[locale]}, the language selected in the app's interface, ` +
      "regardless of the language of the code, the files, the user's message, or these instructions.",
    "Keep code, identifiers, file paths, commands, and technical terms unchanged.",
    END_MARKER,
  ].join("\n");
}

function readExisting(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** The file without the managed block, trimmed; empty when nothing else is in it. */
function withoutBlock(content: string): string {
  return content.replace(BLOCK_PATTERN, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Whether the managed block is present, and the locale it asks for when it is one we recognize. */
export function readLocalizedOutputState(agentDir?: string): {
  enabled: boolean;
  locale?: LocalizedOutputLocale;
  path: string;
} {
  const path = getAppendSystemPromptPath(agentDir);
  const content = readExisting(path);
  if (!BLOCK_PATTERN.test(content)) return { enabled: false, path };
  const locale = content.match(LOCALE_IN_BEGIN)?.[1];
  return {
    enabled: true,
    locale: isLocalizedOutputLocale(locale) ? locale : undefined,
    path,
  };
}

/** Write (or replace) the managed block, keeping any other content in the file. */
export function writeLocalizedOutput(locale: LocalizedOutputLocale, agentDir?: string): {
  enabled: boolean;
  locale: LocalizedOutputLocale;
  path: string;
} {
  const path = getAppendSystemPromptPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const remainder = withoutBlock(readExisting(path));
  const block = localizedOutputBlock(locale);
  writePrivateFileAtomicSync(path, remainder ? `${remainder}\n\n${block}\n` : `${block}\n`);
  return { enabled: true, locale, path };
}

/** Remove the managed block; delete the file when it held nothing else. */
export function clearLocalizedOutput(agentDir?: string): { enabled: boolean; path: string } {
  const path = getAppendSystemPromptPath(agentDir);
  const content = readExisting(path);
  if (!BLOCK_PATTERN.test(content)) return { enabled: false, path };
  const remainder = withoutBlock(content);
  if (remainder) {
    writePrivateFileAtomicSync(path, `${remainder}\n`);
  } else {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { enabled: false, path };
}
