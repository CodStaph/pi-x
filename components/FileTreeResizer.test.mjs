import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShellSource = (await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("exposes an accessible project-tree resize separator", () => {
  assert.match(appShellSource, /data-resize-handle="file-tree"/);
  assert.match(appShellSource, /aria-controls="file-tree-panel"/);
  assert.match(appShellSource, /storageKey: "pi-file-tree-width"/);
});

test("resizes the project tree horizontally as the panel left column", () => {
  // The tree is a column on the panel's left (CSS order puts it first);
  // dragging the divider right grows it. Getting this inverted shrinks the
  // viewer when dragged left.
  assert.doesNotMatch(appShellSource, /axis: "vertical"/);
  assert.match(appShellSource, /growthDirection: "right",\n\s*maxWidth: FILE_TREE_MAX_WIDTH/);
});
test("reclamps the project tree when the available file panel changes", () => {
  assert.match(appShellSource, /const getFileTreeMaxWidth = useCallback/);
  assert.match(appShellSource, /availablePanelWidth = typeof window === "undefined"/);
  assert.match(appShellSource, /: rightPanelWidthRef\.current;/);
  assert.match(appShellSource, /reclampFileTreeWidth\(\)/);
  assert.match(appShellSource, /rightPanelWidth\]\);/);
});

test("the tree grows rightward from the panel's left edge", () => {
  assert.match(appShellSource, /growthDirection: "right",\n\s*maxWidth: FILE_TREE_MAX_WIDTH/);
});

test("a narrow panel collapses the tree only while something is viewed", () => {
  // Rendering is gated on the derived visibility, never the bare preference,
  // or a narrow panel squeezes the viewer until its toolbar clips.
  assert.match(appShellSource, /\{activeCwd && fileTreeShown && \(/);
  assert.doesNotMatch(appShellSource, /\{activeCwd && fileTreeOpen && \(/);
  assert.match(appShellSource, /const fileTreeAutoCollapsed = fileTreeNarrow && panelHasViewer && !fileTreeNarrowOverride;/);
  assert.match(appShellSource, /ref=\{panelBodyRef\} className="right-panel-body"/);
});
