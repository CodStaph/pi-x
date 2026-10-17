import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("popup actions and IPC fallback become stale after another request, context change or unmount", () => {
  const source = readFileSync(new URL("./useMenuRequest.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const state = { current: undefined };
  let cleanup;
  const exports = {};
  vm.runInNewContext(output, { exports, require: () => ({
    useRef: (initial) => { state.current ??= initial; return state; },
    useCallback: (fn) => fn,
    useEffect: (fn) => { cleanup ??= fn(); },
  }) });
  const begin = exports.useMenuRequest("project-a");
  const old = begin();
  assert.equal(old(), true);
  const latest = begin();
  assert.equal(old(), false);
  assert.equal(latest(), true);
  // Context switches invalidate immediately, before passive effects flush.
  exports.useMenuRequest("project-b");
  assert.equal(latest(), false);
  const pending = begin();
  cleanup();
  assert.equal(pending(), false);
  // Strict Mode cleanup must not disable subsequent requests permanently.
  const fresh = exports.useMenuRequest("project-c")();
  assert.equal(fresh(), true);
});
