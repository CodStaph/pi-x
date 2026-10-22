// Pins the agent-route error-code contract: the two literals live in one place,
// both routes use it, and the browser branches on the constant rather than on a
// copy of the string.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AGENT_ERROR_CODES, isAgentErrorCode } = await jiti.import("./agent-error-codes.ts");

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (...parts) => readFileSync(join(repoRoot, ...parts), "utf8");

test("the wire values are stable", () => {
  // The browser and the server are versioned together, but a stored bug report
  // quotes these strings; changing one is a contract change, not a rename.
  assert.deepEqual(AGENT_ERROR_CODES, {
    promptRejected: "prompt_rejected",
    invalidCommand: "invalid_command",
  });
});

test("isAgentErrorCode recognizes exactly the declared values", () => {
  assert.equal(isAgentErrorCode("prompt_rejected"), true);
  assert.equal(isAgentErrorCode("invalid_command"), true);
  assert.equal(isAgentErrorCode("last-model"), false);
  assert.equal(isAgentErrorCode(undefined), false);
  assert.equal(isAgentErrorCode(42), false);
});

test("both agent routes answer with the shared codes", () => {
  for (const file of [["app", "api", "agent", "[id]", "route.ts"], ["app", "api", "agent", "new", "route.ts"]]) {
    const source = read(...file);
    const label = file.join("/");
    assert.match(source, /import \{ AGENT_ERROR_CODES \} from "@\/lib\/agent-error-codes";/, label);
    // No bare literals: a typo on either side would silently stop matching.
    assert.doesNotMatch(source, /code: "prompt_rejected"/, label);
    assert.doesNotMatch(source, /code: "invalid_command"/, label);
  }

  assert.match(read("app", "api", "agent", "[id]", "route.ts"), /code: AGENT_ERROR_CODES\.invalidCommand/);
  assert.match(read("app", "api", "agent", "[id]", "route.ts"), /code: AGENT_ERROR_CODES\.promptRejected/);
  assert.match(read("app", "api", "agent", "new", "route.ts"), /code: AGENT_ERROR_CODES\.invalidCommand/);
});

test("the browser compares through the constant", () => {
  const source = read("lib", "agent-client.ts");
  assert.match(source, /error\.code === AGENT_ERROR_CODES\.promptRejected/);
  assert.doesNotMatch(source, /error\.code === "prompt_rejected"/);
});
