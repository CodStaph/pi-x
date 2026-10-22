// Pins the session command contract (lib/pi/session-commands.ts).
//
// Two kinds of assertion live here:
//   - behaviour: parseSessionCommand() and the flag helpers;
//   - guards: the three hand-maintained command sets this contract replaced must
//     not come back, and no call site may re-introduce an explicit type argument
//     (that is what made a wrong command/result pairing compile silently).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  COMMAND_META,
  COMMAND_TYPES,
  commandTypesWith,
  isCommandType,
  parseSessionCommand,
} = await jiti.import("./session-commands.ts");

const contractSource = readFileSync(new URL("./session-commands.ts", import.meta.url), "utf8");
const rpcManagerSource = readFileSync(new URL("../rpc-manager.ts", import.meta.url), "utf8");
const agentClientSource = readFileSync(new URL("../agent-client.ts", import.meta.url), "utf8");
const postRouteSource = readFileSync(
  new URL("../../app/api/agent/[id]/route.ts", import.meta.url),
  "utf8",
);
const newRouteSource = readFileSync(new URL("../../app/api/agent/new/route.ts", import.meta.url), "utf8");

/** `type` literals declared in the `SessionCommand` union. */
function declaredCommandTypes() {
  return [...contractSource.matchAll(/^\s*\| \(?\{ type: "([a-z_]+)"/gm)].map((match) => match[1]);
}

/** Keys of the `CommandResultMap` interface. */
function declaredResultKeys() {
  const start = contractSource.indexOf("export interface CommandResultMap {");
  assert.ok(start !== -1, "CommandResultMap is missing");
  const body = contractSource.slice(start + "export interface CommandResultMap {".length);
  const end = body.indexOf("\n}");
  assert.ok(end !== -1, "CommandResultMap is not closed");
  return [...body.slice(0, end).matchAll(/^\s{2}([a-z_]+):/gm)].map((match) => match[1]);
}

function parse(body) {
  return parseSessionCommand(body);
}

test("the contract, the runtime table and the result map name the same commands", () => {
  const declared = declaredCommandTypes();
  assert.equal(new Set(declared).size, declared.length, "SessionCommand declares a duplicate type");

  assert.deepEqual([...COMMAND_TYPES].sort(), [...declared].sort());
  assert.deepEqual([...COMMAND_TYPES].sort(), declaredResultKeys().sort());

  // 31 is the number docs/architecture-improvement-plan.zh-CN.md (1.2) reports.
  // A new command is expected to update that number as well as this line.
  assert.equal(COMMAND_TYPES.length, 31);
});

test("dispatch flags stay explicit per command", () => {
  assert.deepEqual([...commandTypesWith("replacesSession")].sort(), ["clone", "fork"]);

  assert.deepEqual(
    [...commandTypesWith("allowedDuringReplacement")].sort(),
    [
      "extension_ui_input",
      "extension_ui_response",
      "get_commands",
      "get_last_assistant_text",
      "get_session_stats",
      "get_state",
      "get_tools",
    ],
  );

  assert.deepEqual(
    [...commandTypesWith("waitsForExtensions")].sort(),
    ["follow_up", "get_commands", "get_state", "prompt", "steer"],
  );

  for (const type of COMMAND_TYPES) {
    assert.equal(typeof COMMAND_META[type], "object", `${type} has no meta entry`);
  }
});

test("isCommandType accepts only declared names", () => {
  assert.equal(isCommandType("prompt"), true);
  assert.equal(isCommandType("get_state"), true);
  assert.equal(isCommandType("nope"), false);
  assert.equal(isCommandType(undefined), false);
  assert.equal(isCommandType(42), false);
  assert.equal(isCommandType("__proto__"), false);
});

test("parseSessionCommand rejects anything the contract does not describe", () => {
  for (const body of [null, undefined, "prompt", 42, [], ["prompt"]]) {
    assert.equal(parse(body).ok, false);
  }

  const unknown = parse({ type: "not_a_command" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unsupported command/);

  const missingType = parse({ message: "hi" });
  assert.equal(missingType.ok, false);
});

test("parseSessionCommand checks the prompt family", () => {
  assert.equal(parse({ type: "prompt" }).ok, false);
  assert.equal(parse({ type: "prompt", message: 42 }).ok, false);
  assert.equal(parse({ type: "steer" }).ok, false);
  assert.equal(parse({ type: "follow_up", message: "x" }).ok, true);

  const legal = parse({ type: "prompt", message: "hi", streamingBehavior: "steer" });
  assert.equal(legal.ok, true);
  assert.equal(legal.command.streamingBehavior, "steer");

  assert.equal(parse({ type: "prompt", message: "hi", streamingBehavior: "queue" }).ok, false);

  const images = [{ type: "image", data: "AAA", mimeType: "image/png" }];
  assert.equal(parse({ type: "prompt", message: "hi", images }).ok, true);
  assert.equal(parse({ type: "prompt", message: "hi", images: "nope" }).ok, false);
  assert.equal(parse({ type: "prompt", message: "hi", images: [{ type: "text", text: "x" }] }).ok, false);

  // Business validation stays in the wrapper: an empty prompt is a shape the
  // route forwards, exactly as before this contract existed.
  assert.equal(parse({ type: "prompt", message: "" }).ok, true);
});

test("toolNames is validated on every command, not just set_tools", () => {
  assert.equal(parse({ type: "prompt", message: "hi", toolNames: "read" }).ok, false);
  assert.equal(parse({ type: "get_state", toolNames: [1] }).ok, false);
  assert.equal(parse({ type: "get_state", toolNames: ["read"] }).ok, true);

  assert.equal(parse({ type: "set_tools" }).ok, true);
  assert.equal(parse({ type: "set_tools", toolNames: ["read", "bash"] }).ok, true);
  assert.equal(parse({ type: "set_tools", toolNames: "read" }).ok, false);
});

test("parseSessionCommand checks the remaining payloads", () => {
  assert.equal(parse({ type: "set_model" }).ok, false);
  assert.equal(parse({ type: "set_model", provider: "p" }).ok, false);
  assert.equal(parse({ type: "set_model", provider: "p", modelId: "m" }).ok, true);

  assert.equal(parse({ type: "set_thinking_level" }).ok, false);
  assert.equal(parse({ type: "set_thinking_level", level: "high" }).ok, true);

  assert.equal(parse({ type: "set_session_name" }).ok, false);
  assert.equal(parse({ type: "set_session_name", name: "x" }).ok, true);

  assert.equal(parse({ type: "fork" }).ok, false);
  assert.equal(parse({ type: "fork", entryId: "e" }).ok, true);
  assert.equal(parse({ type: "fork_branch", entryId: 1 }).ok, false);

  assert.equal(parse({ type: "clone", leafId: null }).ok, true);
  assert.equal(parse({ type: "clone" }).ok, true);
  assert.equal(parse({ type: "clone", leafId: 7 }).ok, false);

  assert.equal(parse({ type: "navigate_tree" }).ok, false);
  assert.equal(parse({ type: "navigate_tree", targetId: "e" }).ok, true);
  assert.equal(parse({ type: "navigate_tree", targetId: "e", summarize: "yes" }).ok, false);

  assert.equal(parse({ type: "compact" }).ok, true);
  assert.equal(parse({ type: "compact", customInstructions: 3 }).ok, false);

  assert.equal(parse({ type: "set_auto_compaction", enabled: true }).ok, true);
  assert.equal(parse({ type: "set_auto_compaction", enabled: "true" }).ok, false);
  assert.equal(parse({ type: "set_auto_retry" }).ok, false);

  assert.equal(parse({ type: "set_steering_mode", mode: "all" }).ok, true);
  assert.equal(parse({ type: "set_steering_mode", mode: "one-at-a-time" }).ok, true);
  assert.equal(parse({ type: "set_steering_mode", mode: "some" }).ok, false);
  assert.equal(parse({ type: "set_follow_up_mode" }).ok, false);

  assert.equal(parse({ type: "bash" }).ok, false);
  assert.equal(parse({ type: "bash", command: "ls" }).ok, true);
  assert.equal(parse({ type: "bash", command: "ls", excludeFromContext: "no" }).ok, false);
});

test("parseSessionCommand covers the extension UI replies", () => {
  assert.equal(parse({ type: "extension_ui_response", id: "1", value: "a" }).ok, true);
  assert.equal(parse({ type: "extension_ui_response", id: "1", confirmed: false }).ok, true);
  assert.equal(parse({ type: "extension_ui_response", id: "1", cancelled: true }).ok, true);
  assert.equal(parse({ type: "extension_ui_response", id: "1" }).ok, false);
  assert.equal(parse({ type: "extension_ui_response", value: "a" }).ok, false);

  assert.equal(parse({ type: "extension_ui_input", id: "1", data: "x" }).ok, true);
  assert.equal(parse({ type: "extension_ui_input", id: "1" }).ok, false);
});

test("payload-free commands are accepted with any extra fields", () => {
  for (const type of ["abort", "abort_retry", "abort_compaction", "abort_branch_summary", "abort_bash", "clear_queue", "get_state", "get_tools", "get_commands", "get_session_stats", "get_last_assistant_text", "reload"]) {
    assert.equal(parse({ type }).ok, true, `${type} should parse`);
  }
  assert.equal(parse({ type: "reload", extra: { deep: true } }).ok, true);
});

test("the three hand-maintained command sets do not come back", () => {
  assert.doesNotMatch(rpcManagerSource, /new Set\(\["fork", "clone"\]\)/);
  assert.doesNotMatch(rpcManagerSource, /private shouldWaitForExtensions\(type: string\)/);
  assert.doesNotMatch(rpcManagerSource, /type === "prompt"\s*\n\s*\|\| type === "steer"/);

  assert.match(rpcManagerSource, /commandTypesWith\("replacesSession"\)/);
  assert.match(rpcManagerSource, /commandTypesWith\("allowedDuringReplacement"\)/);
  assert.match(rpcManagerSource, /COMMAND_META\[type\]\.waitsForExtensions === true/);
  assert.match(rpcManagerSource, /async send\(command: SessionCommand\): Promise<unknown>/);
});

test("both agent routes validate through the contract", () => {
  assert.match(postRouteSource, /parseSessionCommand\(await req\.json\(\)\)/);
  // The value itself lives in lib/agent-error-codes.ts (pinned by its own test).
  assert.match(postRouteSource, /code: AGENT_ERROR_CODES\.invalidCommand/);
  assert.match(postRouteSource, /existing\.send\(command\)/);

  assert.match(newRouteSource, /parseSessionCommand\(promptCommand\)/);
  assert.match(newRouteSource, /session\.send\(sessionCommand\)/);
});

test("sendAgentCommand derives its result from the command name", () => {
  assert.match(agentClientSource, /sendAgentCommand<T extends CommandType>/);
  assert.match(agentClientSource, /command: CommandOf<T>/);
  assert.match(agentClientSource, /Promise<CommandResult<T>>/);
  assert.doesNotMatch(agentClientSource, /command: Record<string, unknown>/);
});

test("no call site passes an explicit type argument", () => {
  const roots = ["lib", "hooks", "components", "app"];
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      // The declaration itself; its shape is asserted separately above.
      if (path.endsWith("agent-client.ts")) continue;
      if (readFileSync(path, "utf8").includes("sendAgentCommand<")) {
        offenders.push(path.slice(repoRoot.length).replaceAll(sep, "/"));
      }
    }
  };

  for (const root of roots) walk(join(repoRoot, root));

  assert.deepEqual(offenders, [], "a call site re-declared the result type instead of using CommandResultMap");
});
