import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// terminal-tab-state imports the shell-id validator through the `@/` alias, so
// it goes through jiti like the other source-reading tests.
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { newTerminalTab, restoreTerminalTabs } = await jiti.import("./terminal-tab-state");

test("restored workspace tabs retain terminal identity and never request a new shell", () => {
  const first = newTerminalTab("/repo/worktree-a");
  const second = newTerminalTab("/repo/worktree-b");
  assert.notEqual(first.id, second.id);
  const saved = restoreTerminalTabs(JSON.stringify({ tabs: [first, second], activeId: second.id, open: true }));
  assert.deepEqual(saved, {
    tabs: [{ ...first, restored: true }, { ...second, restored: true }],
    activeId: second.id,
    open: true,
  });
});

test("restored tabs keep their shell and allow the same cwd on different shells", () => {
  const cmd = newTerminalTab("/repo", "cmd");
  const gitBash = newTerminalTab("/repo", "git-bash");
  assert.equal(cmd.shell, "cmd");
  const saved = restoreTerminalTabs(JSON.stringify({
    tabs: [cmd, gitBash, { ...cmd, id: newTerminalTab("/repo", "cmd").id }, { ...newTerminalTab("/x"), shell: "evil" }],
    activeId: gitBash.id,
  }));
  assert.deepEqual(
    saved.tabs.map((tab) => [tab.cwd, tab.shell]),
    [["/repo", "cmd"], ["/repo", "git-bash"], ["/x", undefined]],
  );
  assert.equal(saved.activeId, gitBash.id);
  assert.ok(saved.tabs.every((tab) => tab.restored === true));
});

test("storage corruption cannot create invalid or duplicate terminal tabs", () => {
  assert.deepEqual(restoreTerminalTabs("broken"), { tabs: [], activeId: null, open: false });
  assert.deepEqual(restoreTerminalTabs(null), { tabs: [], activeId: null, open: false });
  const tab = newTerminalTab("/repo");
  const saved = restoreTerminalTabs(JSON.stringify({
    tabs: [null, {}, tab, tab, { ...tab, id: "../../bad" }, { ...tab, cwd: null }],
    activeId: "missing",
  }));
  assert.deepEqual(saved, { tabs: [{ ...tab, restored: true }], activeId: null, open: false });
});
