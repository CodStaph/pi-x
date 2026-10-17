import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The window background image store: option clamping, persistence and the
 * DOM projection. The module reads `window.localStorage` through app-prefs
 * and writes CSS variables/classes on `document.documentElement`, so both are
 * stubbed here and the module is loaded through jiti's `@/` alias.
 */

function createRoot() {
  const classes = new Set();
  const properties = new Map();
  return {
    classes,
    properties,
    element: {
      classList: {
        toggle(name, value) {
          if (value) classes.add(name);
          else classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          properties.set(name, value);
        },
        removeProperty(name) {
          properties.delete(name);
        },
      },
    },
  };
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => {
        values.set(key, String(value));
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
  };
}

const root = createRoot();
const { storage, values } = createStorage();
globalThis.window = { localStorage: storage };
globalThis.document = { documentElement: root.element };

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  DEFAULT_APP_BACKGROUND_OPTIONS,
  applyAppBackgroundToDom,
  getAppBackgroundSnapshot,
  setAppBackgroundImage,
  updateAppBackgroundOptions,
} = await jiti.import("./app-background");

test("defaults to no image with cover fit and a readable dim", () => {
  const state = getAppBackgroundSnapshot();
  assert.equal(state.image, null);
  assert.deepEqual(state.options, DEFAULT_APP_BACKGROUND_OPTIONS);
});

test("clamps dim and blur and persists only valid options", () => {
  updateAppBackgroundOptions({ dim: 5, blur: 99, fit: "contain", enabled: false });
  const stored = JSON.parse(values.get("pi-background-image-options"));
  assert.equal(stored.dim, 0.85);
  assert.equal(stored.blur, 24);
  assert.equal(stored.fit, "contain");
  assert.equal(stored.enabled, false);

  updateAppBackgroundOptions({ dim: -1, blur: -4, fit: "nonsense" });
  const next = getAppBackgroundSnapshot();
  assert.equal(next.options.dim, 0);
  assert.equal(next.options.blur, 0);
  assert.equal(next.options.fit, "contain");
});

test("projects the image and class onto the root element", () => {
  updateAppBackgroundOptions({ enabled: true, fit: "cover" });
  const dataUrl = "data:image/png;base64,AAAA";
  setAppBackgroundImage(dataUrl);
  assert.equal(getAppBackgroundSnapshot().image, dataUrl);
  assert.equal(values.get("pi-background-image"), dataUrl);
  assert.ok(root.classes.has("has-app-background"));
  assert.equal(root.properties.get("--app-bg-image"), `url("${dataUrl}")`);
  // dim is written as a percentage so color-mix() can consume it directly.
  assert.match(root.properties.get("--app-bg-dim"), /^\d+(\.\d+)?%$/);
  assert.equal(root.properties.get("--app-bg-size"), "cover");

  setAppBackgroundImage(null);
  assert.equal(getAppBackgroundSnapshot().image, null);
  assert.equal(values.has("pi-background-image"), false);
  assert.equal(root.classes.has("has-app-background"), false);
  assert.equal(root.properties.has("--app-bg-image"), false);
});

test("disabling the option hides an image without deleting it", () => {
  setAppBackgroundImage("data:image/png;base64,BBBB");
  updateAppBackgroundOptions({ enabled: false });
  assert.equal(root.classes.has("has-app-background"), false);
  assert.equal(getAppBackgroundSnapshot().image, "data:image/png;base64,BBBB");

  updateAppBackgroundOptions({ enabled: true });
  applyAppBackgroundToDom();
  assert.ok(root.classes.has("has-app-background"));
  setAppBackgroundImage(null);
});

test("the top bar keeps its glass effect off the fixed dropdown's containing block", async () => {
  const css = await readFile(new URL("../app/native-theme.css", import.meta.url), "utf8");
  // The top-bar "More" dropdown is position:fixed and positioned from the top
  // bar's viewport rect. backdrop-filter on .app-topbar itself would make the
  // top bar the containing block for that fixed child, so left/top would be
  // applied twice and the panel would drift. The filter must stay on ::before.
  const topbarBlock = /html\.has-app-background \.app-topbar \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.doesNotMatch(topbarBlock, /backdrop-filter/);
  const pseudoBlock = /html\.has-app-background \.app-topbar::before \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(pseudoBlock, /backdrop-filter/);
});
