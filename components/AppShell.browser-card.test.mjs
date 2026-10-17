import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the embedded browser is a right-panel tab, not a separate column", () => {
  assert.match(source, /const BROWSER_TAB_ID = "browser"/);
  assert.match(source, /kind: "browser" as const/);
  assert.match(source, /\{browserOpen && \(/);
  // The old side-by-side card and its resizer are gone.
  assert.doesNotMatch(source, /className="browser-card"/);
  assert.doesNotMatch(source, /data-resize-handle="browser-card"/);
  assert.doesNotMatch(source, /browserCardResizer/);
});

test("the browser tab is mounted inside the right panel content", () => {
  const panel = source.indexOf('id="file-panel"');
  const browserPanel = source.indexOf("<BrowserPanel initialUrl={browserUrl}");
  assert.notEqual(panel, -1, "right panel not found");
  assert.notEqual(browserPanel, -1, "browser panel not mounted");
  assert.ok(browserPanel > panel, "the browser page view must live inside the right panel");
});

test("the browser pane is a flex column so it tracks the pane height", () => {
  // .context-browser-panel relies on flex:1; a plain block wrapper left the
  // iframe at its intrinsic height, so resizing the right panel did nothing.
  const start = source.indexOf("{browserOpen && (");
  assert.notEqual(start, -1, "browser mount not found");
  const block = source.slice(start, start + 600);
  assert.match(block, /display: "flex", flexDirection: "column", minHeight: 0/);
  assert.match(block, /<BrowserPanel/);
});

test("browser page view reuses the existing BrowserPanel and the topbar toggle", () => {
  assert.match(source, /import \{ BrowserPanel \} from "\.\/BrowserPanel"/);
  assert.match(source, /<BrowserPanel initialUrl=\{browserUrl\} onUrlChange=\{setBrowserUrl\} \/>/);
  assert.match(source, /const handleToggleBrowser = useCallback/);
  assert.match(source, /renderBrowserToggle/);
  assert.match(source, /\{!isMobile && renderBrowserToggle\(\)\}/);
});
