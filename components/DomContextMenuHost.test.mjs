import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function menuHarness({ buttons = [], activeElement = null, width = 300, height = 200 } = {}) {
  const effects = [];
  const updates = [];
  const errors = [];
  const listeners = new Map();
  let closed = 0;
  const root = { contains: (target) => target === root, querySelectorAll: () => buttons };
  const document = { activeElement, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const window = { innerWidth: width, innerHeight: height, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  const source = readFileSync(new URL("./DomContextMenuHost.tsx", import.meta.url), "utf8");
  const output = ts.transpileModule(source + "\nexport { MenuPanel, MenuView };", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(output, {
    exports, document, window, console: { error: (...args) => errors.push(args) },
    require: (name) => {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "react") return {
        useCallback: (fn) => fn, useLayoutEffect: () => {},
        useEffect: (fn) => effects.push(fn), useRef: () => ({ current: root }),
        useState: () => [null, (value) => updates.push(value)],
      };
      if (name === "react-dom") return {};
      if (name === "@/lib/dom-menu-store") return { closeDomMenu: () => { closed++; } };
      if (name === "@/lib/ime") return { isImeComposing: (event) => !!event.isComposing || !!event.nativeEvent?.isComposing };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return { ...exports, root, effects, updates, errors, listeners, closed: () => closed };
}

test("DOM menu keeps disabled submenus inert and exposes check items", () => {
  const h = menuHarness();
  let opened = 0;
  const tree = h.MenuPanel({
    entries: [
      { kind: "submenu", label: "Disabled", disabled: true, items: [] },
      { label: "Checked", checked: true },
      { kind: "separator" },
    ],
    panelRef: { current: h.root }, place: () => ({ left: 8, top: 8 }),
    onSubmenu: () => { opened++; }, onItem: () => {},
  });
  const children = tree.props.children;
  children[0].props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({}) } });
  assert.equal(opened, 0);
  assert.equal(children[0].props.disabled, true);
  assert.equal(children[1].props.role, "menuitemcheckbox");
  assert.equal(children[1].props["aria-checked"], true);
  assert.equal(children[2].props.role, "separator");
});

test("DOM menu keyboard wraps in both directions and ignores IME arrows", () => {
  const focused = [];
  const buttons = [0, 1].map((index) => ({ focus: () => focused.push(index) }));
  const h = menuHarness({ buttons, activeElement: buttons[1] });
  const tree = h.MenuPanel({ entries: [], panelRef: { current: h.root }, place: () => ({}), onItem: () => {} });
  let prevented = 0;
  tree.props.onKeyDown({ key: "ArrowDown", preventDefault: () => { prevented++; } });
  assert.deepEqual(focused, [0]);
  tree.props.onKeyDown({ key: "ArrowUp", preventDefault: () => { prevented++; } });
  assert.deepEqual(focused, [0, 0]);
  tree.props.onKeyDown({ key: "ArrowDown", isComposing: true, preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2);
});

test("DOM menu clamps to the viewport and closes on outside interaction with cleanup", () => {
  const h = menuHarness();
  const tree = h.MenuView({ menu: { at: { x: 1000, y: 1000 }, entries: [] } });
  const position = tree.props.children[0].props.place({ width: 100, height: 80 });
  assert.equal(position.left, 192);
  assert.equal(position.top, 112);
  const cleanup = h.effects[0]();
  h.listeners.get("pointerdown")({ target: h.root });
  assert.equal(h.closed(), 0);
  h.listeners.get("pointerdown")({ target: {} });
  assert.equal(h.closed(), 1);
  h.listeners.get("keydown")({ key: "Escape", isComposing: true });
  assert.equal(h.closed(), 1);
  h.listeners.get("keydown")({ key: "Escape", preventDefault: () => {} });
  assert.equal(h.closed(), 2);
  cleanup();
  assert.equal(h.listeners.size, 0);
});

test("DOM actions close first, absorb sync and async errors, and reject disabled actions", async () => {
  const h = menuHarness();
  const tree = h.MenuView({ menu: { at: { x: 0, y: 0 }, entries: [] } });
  const onItem = tree.props.children[0].props.onItem;
  onItem({ disabled: true, onSelect: () => assert.fail("disabled action ran") });
  assert.equal(h.closed(), 0);
  onItem({ onSelect: () => { assert.equal(h.closed(), 1); throw new Error("sync"); } });
  onItem({ onSelect: async () => { throw new Error("async"); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.closed(), 2);
  assert.equal(h.errors.length, 2);
  assert.equal(h.errors[0][0], "[desktop-menu] menu action failed");
});
