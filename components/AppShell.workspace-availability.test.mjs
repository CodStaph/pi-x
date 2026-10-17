import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("AppShell.tsx", readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findCheck(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
      && node.arguments[0]?.getText(source).includes("/api/cwd/status?")) return node.arguments[0];
  return ts.forEachChild(node, findCheck);
}
const script = new Script(ts.transpileModule(findCheck(source).getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(previous = null) {
  const requests = [];
  const states = [];
  let refreshes = 0;
  const context = {
    projectTrustCwd: "/project", AbortController, DOMException,
    workspaceStatusRef: { current: previous },
    fetch(url, { signal }) {
      return new Promise((resolve, reject) => requests.push({ url, signal, resolve, reject }));
    },
    setWorkspaceStatus(state) { states.push(state); },
    setModelsRefreshKey(update) { refreshes = update(refreshes); },
  };
  const check = script.runInNewContext(context);
  return { context, requests, states, check, refreshes: () => refreshes };
}

function answer(request, availability, ok = true) {
  request.resolve({ ok, json: async () => ({ availability }) });
}

test("only recovery of the same unavailable cwd refreshes models", async () => {
  for (const availability of [null, "available", "unknown", "missing", "not-directory", "unreadable"]) {
    for (const cwd of ["/project", "/other"]) {
      const h = harness(availability ? { cwd, availability } : null);
      h.check();
      answer(h.requests[0], "available");
      await flush();
      assert.equal(h.states[0].availability, "available");
      assert.equal(h.refreshes(), cwd === "/project" && ["missing", "not-directory", "unreadable"].includes(availability) ? 1 : 0);
    }
  }
});

test("manual recheck replaces unavailable status and refreshes the model error once", async () => {
  const h = harness();
  h.check();
  answer(h.requests[0], "missing");
  await flush();
  assert.equal(h.context.workspaceStatusRef.current.availability, "missing");
  h.check();
  answer(h.requests[1], "available");
  await flush();
  assert.equal(h.refreshes(), 1);
  h.check();
  answer(h.requests[2], "available");
  await flush();
  assert.equal(h.refreshes(), 1);
});

test("HTTP and network failures become unknown, while cancelled stale responses cannot replace the new cwd", async () => {
  for (const fail of ["http", "network"]) {
    const h = harness();
    h.check();
    if (fail === "http") answer(h.requests[0], undefined, false);
    else h.requests[0].reject(new Error("offline"));
    await flush();
    assert.equal(h.states[0].availability, "unknown");
  }
  const h = harness();
  const cancel = h.check();
  cancel();
  assert.equal(h.requests[0].signal.aborted, true);
  h.context.projectTrustCwd = "/other";
  h.check();
  answer(h.requests[1], "available");
  await flush();
  answer(h.requests[0], "missing");
  await flush();
  assert.equal(h.states.length, 1);
  assert.equal(h.states[0].cwd, "/other");
});
