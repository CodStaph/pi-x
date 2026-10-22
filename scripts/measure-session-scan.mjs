#!/usr/bin/env node
/**
 * Baseline measurement for the session-list scan (stage F3 of
 * docs/architecture-improvement-plan.zh-CN.md).
 *
 * `listAllSessions()` walks `<agentDir>/sessions` and parses each file it has not
 * seen before; the sidebar refetches that list after every turn. Whether the
 * synchronous reads inside `session-reader.ts` are a bottleneck depends on how
 * many sessions a real user accumulates — which nobody measured, so the plan says
 * "measure before optimizing". This is that measurement.
 *
 * Each size runs in its own child process with `PI_CODING_AGENT_DIR` pointing at a
 * throwaway agent directory, because `listSessionsIncremental()` resolves the
 * sessions dir from the SDK and keeps a module-level index. A child process gives
 * an honest cold start (empty index) and keeps the user's real sessions untouched.
 *
 * Usage:
 *   node scripts/measure-session-scan.mjs                  # 10 and 100 sessions
 *   node scripts/measure-session-scan.mjs --sizes=10,100,1000
 *   node scripts/measure-session-scan.mjs --json
 *
 * The numbers are a baseline, not a gate: `scripts/session-scan-baseline.json`
 * records them, and only a large regression there is worth acting on.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));

function parseSizes(argv) {
  const flag = argv.find((arg) => arg.startsWith("--sizes="));
  const raw = flag ? flag.slice("--sizes=".length) : "10,100";
  const sizes = raw.split(",").map((value) => Number.parseInt(value.trim(), 10));
  if (sizes.length === 0 || sizes.some((size) => !Number.isFinite(size) || size <= 0)) {
    throw new Error(`--sizes must be a comma-separated list of positive integers, got "${raw}"`);
  }
  return sizes;
}

/** Build `count` minimal but realistic session files under `agentDir`. */
function writeSessions(agentDir, count) {
  const dir = join(agentDir, "sessions", "--bench-project--");
  mkdirSync(dir, { recursive: true });
  const base = Date.UTC(2026, 0, 1);

  for (let index = 0; index < count; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const timestamp = new Date(base + index * 60_000).toISOString();
    const lines = [
      { type: "session", version: 3, id, timestamp, cwd: "/tmp/bench-project" },
      {
        type: "message",
        id: `${index}a1`,
        parentId: null,
        timestamp,
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        id: `${index}a2`,
        parentId: `${index}a1`,
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          model: "bench-model",
          provider: "bench",
          stopReason: "stop",
        },
      },
      { type: "session_info", id: `${index}a3`, parentId: `${index}a2`, timestamp, name: `bench ${index}` },
    ];
    const file = `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`;
    writeFileSync(join(dir, file), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }
  return count;
}

/**
 * Child mode: scan twice in a fresh process and report the timings.
 *
 * Cold = first call (empty index, every file parsed). Warm = second call (only
 * stat fingerprints, nothing re-parsed).
 */
async function runChild(size, agentDir) {
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { listSessionsIncremental } = await jiti.import(join(ROOT, "lib/session-list-scanner.ts"));

  const time = async () => {
    const started = process.hrtime.bigint();
    const sessions = await listSessionsIncremental();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { elapsedMs, count: sessions.length };
  };

  const cold = await time();
  const warm = await time();
  process.stdout.write(`${JSON.stringify({ size, cold, warm })}\n`);
}

function measureSize(size) {
  const agentDir = mkdtempSync(join(tmpdir(), `pi-scan-${size}-`));
  try {
    writeSessions(agentDir, size);
    const output = execFileSync(
      process.execPath,
      ["--experimental-strip-types", SELF, "--run", String(size), agentDir],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env } },
    );
    return JSON.parse(output.trim().split("\n").at(-1));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
if (argv[0] === "--run") {
  await runChild(Number(argv[1]), argv[2]);
} else {
  const json = argv.includes("--json");
  const sizes = parseSizes(argv);
  const rows = sizes.map((size) => measureSize(size));

  if (json) {
    process.stdout.write(`${JSON.stringify({ measuredAt: new Date().toISOString(), rows }, null, 2)}\n`);
  } else {
    console.log("sessions   files   cold ms   warm ms   ms/file (cold)");
    for (const row of rows) {
      console.log(
        String(row.size).padStart(8),
        String(row.cold.count).padStart(7),
        row.cold.elapsedMs.toFixed(1).padStart(9),
        row.warm.elapsedMs.toFixed(1).padStart(9),
        (row.cold.elapsedMs / Math.max(1, row.cold.count)).toFixed(2).padStart(15),
      );
    }
    console.log("\nCold = first scan in a fresh process (empty index). Warm = second scan (stat only).");
    console.log("A regression here is worth investigating only after it shows up in a real session list.");
  }
}
