import { isTerminalShellId } from "@/lib/terminal-shells";

export interface TerminalTab {
  id: string;
  cwd: string;
  /** Selected shell profile id; undefined means the platform/auto default. */
  shell?: string;
  restored?: boolean;
  closing?: "close" | "restart";
}

export const TERMINAL_TABS_KEY = "pi-web:terminal-tabs";

export function newTerminalTab(cwd: string, shell?: string): TerminalTab {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return shell ? { id, cwd, shell } : { id, cwd };
}

export function restoreTerminalTabs(raw: string | null): { tabs: TerminalTab[]; activeId: string | null; open: boolean } {
  try {
    const saved = JSON.parse(raw ?? "null");
    const tabs: TerminalTab[] = [];
    for (const tab of Array.isArray(saved?.tabs) ? saved.tabs : []) {
      const shell = isTerminalShellId(tab?.shell) ? tab.shell : undefined;
      if (tab && typeof tab.id === "string" && /^[a-f0-9]{32}$/.test(tab.id)
        && typeof tab.cwd === "string" && tab.cwd.trim()
        && !tabs.some((existing) => existing.id === tab.id
          || (existing.cwd === tab.cwd && (existing.shell ?? "auto") === (shell ?? "auto")))) {
        tabs.push(shell ? { id: tab.id, cwd: tab.cwd, shell, restored: true } : { id: tab.id, cwd: tab.cwd, restored: true });
      }
    }
    return { tabs, activeId: tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : null, open: saved?.open === true };
  } catch {
    return { tabs: [], activeId: null, open: false };
  }
}
