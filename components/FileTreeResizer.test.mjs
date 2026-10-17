import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShellSource = (await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("exposes an accessible project-tree resize separator", () => {
  assert.match(appShellSource, /data-resize-handle="file-tree"/);
  assert.match(appShellSource, /aria-controls="file-tree-panel"/);
  assert.match(appShellSource, /storageKey: "pi-file-tree-width"/);
});

test("resizes the project tree vertically with the divider moving down", () => {
  // The tree stacks above the viewer/terminal; dragging the divider down grows
  // the tree. Getting this inverted shrinks the terminal when dragged up.
  assert.match(appShellSource, /axis: "vertical"/);
  assert.match(appShellSource, /growthDirection: "down"/);
});
test("reclamps the project tree when the available file panel changes", () => {
  assert.match(appShellSource, /const getFileTreeMaxWidth = useCallback/);
  assert.match(appShellSource, /availablePanelHeight = typeof window === "undefined"/);
  assert.match(appShellSource, /: window\.innerHeight;/);
  assert.match(appShellSource, /reclampFileTreeWidth\(\)/);
  assert.match(appShellSource, /rightPanelWidth\]\);/);
});

test("the file list renders from the plain toggle in a stacked panel", () => {
  // A stacked tree no longer steps aside on narrow panels: it takes height, not
  // width, so the viewer keeps its toolbar.
  assert.match(appShellSource, /\{activeCwd && fileTreeOpen && \(/);
  assert.doesNotMatch(appShellSource, /fileTreeShown|fileTreeNarrow/);
});
