import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
import { tidyMenuEntries, toPopupSpec } from "../lib/desktop-menu-model.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { revealLabelKey } = await jiti.import("../lib/file-context-menu.ts");

function load(path, modules, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: (name) => {
    assert.ok(name in modules, `Unexpected import: ${name}`);
    return modules[name];
  }, console, process, ...globals });
  return exports;
}

test("popup IPC failure requests fallback; sync and async action failures never request it", async () => {
  for (const failure of ["ipc", "sync", "async", "dismiss"]) {
    const errors = [];
    const warnings = [];
    const menu = load("../lib/desktop-menu.ts", {
      "./desktop-menu-model": { tidyMenuEntries, toPopupSpec },
      "@/lib/desktop-updater": { isTauriDesktop: () => true },
      "@tauri-apps/api/core": { invoke: async () => {
        if (failure === "ipc") throw new Error("IPC unavailable");
        return failure === "dismiss" ? null : "0";
      } },
    }, { process: { env: {} }, console: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) } });
    const shown = await menu.showNativeMenu([{ label: "Open", onSelect: () => {
      if (failure === "sync") throw new Error("action failed");
      if (failure === "async") return Promise.reject(new Error("async action failed"));
    } }]);
    assert.equal(shown, failure !== "ipc");
    assert.equal(warnings.length, failure === "ipc" ? 1 : 0);
    assert.equal(errors.length, ["sync", "async"].includes(failure) ? 1 : 0);
  }
});

function FileMenuHarness({ desktop = true, native = false, platform = "windows", apps = null } = {}) {
  let cleanup;
  let refIndex = 0;
  const refs = [];
  let effectMounted = false;
  let translate = (key) => key;
  const pending = [];
  const menus = [];
  const fallbacks = [];
  const opened = [];
  const appLookups = [];
  const openedWith = [];
  const modules = {
    react: {
      useRef: (value) => refs[refIndex++] ??= { current: value },
      useCallback: (fn) => fn,
      useEffect: (fn) => { if (!effectMounted) { cleanup = fn(); effectMounted = true; } },
    },
    "@/hooks/useI18n": { useI18n: () => ({ t: translate }) },
    "@/lib/clipboard": { copyText: async () => {} },
    "@/lib/desktop-menu": { showNativeMenu: async (entries, at) => { menus.push({ entries, at }); return native; } },
    "@/lib/dom-menu-store": { openDomMenu: (entries, at) => fallbacks.push({ entries, at }) },
    "@/lib/desktop-updater": { isTauriDesktop: () => desktop },
    "@/lib/desktop-native": {
      openPathNative: async () => {},
      revealItemInDirNative: async () => {},
      listAppsForFileNative: async (path) => { appLookups.push(path); return apps ?? []; },
      openPathWithNative: async (path, app) => { openedWith.push([path, app]); },
      selectApplicationNative: async () => "/Applications/TextEdit.app",
    },
    "@/lib/desktop-window": { getDesktopPlatform: () => platform },
    "@/lib/file-context-menu": {
      buildFileMenuEntries: (labels, actions) => [{ label: labels.open, onSelect: actions.open }],
      appListCacheKey: (path) => path.split(".").pop(),
      revealLabelKey,
    },
    "@/lib/file-paths": { encodeFilePathForApi: encodeURIComponent },
  };
  const { useFileContextMenu } = load("./useFileContextMenu.ts", modules, {
    AbortSignal,
    fetch: (url) => new Promise((resolve) => pending.push({ url, resolve })),
  });
  let prevented = 0;
  const event = { clientX: 40, clientY: 50, preventDefault: () => prevented++, stopPropagation: () => {} };
  const initialOpen = (...args) => opened.push(args);
  let handler;
  function render(onOpen = initialOpen, t = translate) {
    refIndex = 0;
    translate = t;
    function FileMenuRender() { return useFileContextMenu(onOpen); }
    handler = FileMenuRender();
  }
  render();
  return { get handler() { return handler; }, render, event, pending, menus, fallbacks, opened, appLookups, openedWith, cleanup: () => cleanup(), prevented: () => prevented };
}
test("file menu context changes invalidate lookups and visible actions before effect cleanup", async () => {
  for (const change of ["callback", "translation"]) {
    for (const phase of ["lookup", "visible-action"]) {
      const h = FileMenuHarness();
      h.handler(h.event, { filePath: "D:/old.txt", verify: phase === "lookup" });
      await flush();
      if (change === "callback") h.render(() => assert.fail("stale callback used"));
      else h.render(undefined, (key) => `translated:${key}`);
      if (phase === "lookup") h.pending[0].resolve({ ok: true });
      await flush();
      const previousMenus = phase === "lookup" ? 0 : 1;
      assert.equal(h.menus.length, previousMenus);
      assert.equal(h.fallbacks.length, previousMenus);
      if (phase === "visible-action") h.fallbacks[0].entries[0].onSelect();
      assert.equal(h.opened.length, 0);
      h.handler(h.event, { filePath: "D:/fresh.txt" });
      await flush();
      assert.equal(h.menus.length, previousMenus + 1, "new context can still open a menu");
    }
  }
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("browser file context menu leaves the event untouched and does no lookup", async () => {
  const h = FileMenuHarness({ desktop: false });
  h.handler(h.event, { filePath: "D:/project/file.pdf", verify: true });
  await flush();
  assert.equal(h.prevented(), 0);
  assert.equal(h.pending.length, 0);
  assert.equal(h.menus.length, 0);
});

test("only the latest authorised file request opens a menu and fallback preserves PDF page", async () => {
  const h = FileMenuHarness();
  h.handler(h.event, { filePath: "D:/old.txt", verify: true });
  h.handler(h.event, { filePath: "D:/new.pdf", page: 3, verify: true });
  h.pending[1].resolve({ ok: true });
  await flush();
  h.pending[0].resolve({ ok: true });
  await flush();
  assert.equal(h.menus.length, 1);
  assert.equal(h.fallbacks.length, 1);
  assert.equal(h.fallbacks[0].at.x, 40);
  h.fallbacks[0].entries[0].onSelect();
  assert.deepEqual(h.opened, [["D:/new.pdf", 3]]);
  h.cleanup();
  h.fallbacks[0].entries[0].onSelect();
  assert.equal(h.opened.length, 1, "an already displayed menu cannot act after unmount");
});

test("denied and unmounted file lookups cannot open either menu", async () => {
  for (const unmount of [false, true]) {
    const h = FileMenuHarness();
    h.handler(h.event, { filePath: "D:/private.txt", verify: true });
    if (unmount) h.cleanup();
    h.pending[0].resolve({ ok: unmount });
    await flush();
    assert.equal(h.menus.length, 0);
    assert.equal(h.fallbacks.length, 0);
  }
});

test("macOS looks up the Open With apps; other platforms never ask", async () => {
  const macApps = [
    { name: "Typora", path: "/Applications/Typora.app", isDefault: true },
    { name: "TextEdit", path: "/System/Applications/TextEdit.app", isDefault: false },
  ];
  const mac = FileMenuHarness({ platform: "macos", apps: macApps });
  mac.handler(mac.event, { filePath: "/Users/me/project/a.md" });
  await flush();
  assert.deepEqual(mac.appLookups, ["/Users/me/project/a.md"]);
  assert.equal(mac.menus.length, 1);

  const windows = FileMenuHarness({ platform: "windows" });
  windows.handler(windows.event, { filePath: "D:/project/a.md" });
  await flush();
  assert.deepEqual(windows.appLookups, [], "Open With is macOS-only");
  assert.equal(windows.menus.length, 1);
});
