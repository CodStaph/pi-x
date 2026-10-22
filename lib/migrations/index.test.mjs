// Pins lib/migrations: ordering, the ledger (idempotence, per-migration writes),
// the failure contract (stop, keep user data, retry later) and the backup hook.
//
// The registry itself is empty in the repository — no pi-web-owned file has needed
// a shape change yet — so every assertion injects its own migrations. That is the
// point: the runner is proven before the first real migration needs it.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MIGRATIONS,
  getMigrationFailure,
  migrationsStatePath,
  readMigrationLedger,
  runMigrations,
  runStartupMigrations,
  validateMigrations,
} = await jiti.import("./index.ts");

function workspace() {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-migrations-"));
  return { agentDir, cleanup: () => rmSync(agentDir, { recursive: true, force: true }) };
}

const fixedClock = () => new Date("2026-10-21T12:00:00.000Z");

test("the repository registry is empty and therefore never touches the disk", async () => {
  assert.deepEqual(MIGRATIONS, []);

  const { agentDir, cleanup } = workspace();
  try {
    const result = await runMigrations({ agentDir, now: fixedClock });
    assert.deepEqual(result, { ok: true, applied: [], skipped: [] });
    // No ledger is written for a no-op run.
    assert.equal(existsSync(migrationsStatePath(agentDir)), false);
  } finally {
    cleanup();
  }
});

test("migrations run in version order regardless of registration order", async () => {
  const { agentDir, cleanup } = workspace();
  const calls = [];
  try {
    const result = await runMigrations({
      agentDir,
      now: fixedClock,
      migrations: [
        { id: "second", version: 20, up: () => { calls.push("second"); } },
        { id: "first", version: 10, up: () => { calls.push("first"); } },
        { id: "third", version: 30, up: () => { calls.push("third"); } },
      ],
    });

    assert.deepEqual(calls, ["first", "second", "third"]);
    assert.deepEqual(result.applied, ["first", "second", "third"]);
    assert.deepEqual(result.skipped, []);
  } finally {
    cleanup();
  }
});

test("the ledger makes a second run a no-op", async () => {
  const { agentDir, cleanup } = workspace();
  let runs = 0;
  const migrations = [{ id: "once", version: 1, up: () => { runs += 1; } }];
  try {
    const first = await runMigrations({ agentDir, migrations, now: fixedClock });
    assert.deepEqual(first.applied, ["once"]);

    const second = await runMigrations({ agentDir, migrations, now: fixedClock });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ["once"]);
    assert.equal(runs, 1, "an applied migration must not run again");
  } finally {
    cleanup();
  }
});

test("the ledger records id, version and timestamp", async () => {
  const { agentDir, cleanup } = workspace();
  try {
    await runMigrations({
      agentDir,
      now: fixedClock,
      migrations: [{ id: "stamp", version: 7, up: () => {} }],
    });

    const ledger = JSON.parse(readFileSync(migrationsStatePath(agentDir), "utf8"));
    assert.deepEqual(ledger, {
      schemaVersion: 1,
      applied: [{ id: "stamp", version: 7, at: "2026-10-21T12:00:00.000Z" }],
    });
  } finally {
    cleanup();
  }
});

test("a failure stops the sequence and keeps the completed prefix", async () => {
  const { agentDir, cleanup } = workspace();
  const calls = [];
  const migrations = [
    { id: "ok", version: 1, up: () => { calls.push("ok"); } },
    { id: "broken", version: 2, up: () => { calls.push("broken"); throw new Error("bad data"); } },
    { id: "after", version: 3, up: () => { calls.push("after"); } },
  ];
  try {
    const result = await runMigrations({ agentDir, migrations, now: fixedClock });

    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, { id: "broken", error: "bad data" });
    assert.deepEqual(result.applied, ["ok"]);
    assert.deepEqual(calls, ["ok", "broken"], "nothing after the failure may run");

    // The failed one is not recorded, so it is retried after the fix.
    const ledger = readMigrationLedger(agentDir);
    assert.deepEqual(ledger.applied.map((entry) => entry.id), ["ok"]);

    let repaired = false;
    const retry = await runMigrations({
      agentDir,
      now: fixedClock,
      migrations: [
        migrations[0],
        { id: "broken", version: 2, up: () => { repaired = true; } },
        migrations[2],
      ],
    });
    assert.equal(repaired, true);
    assert.deepEqual(retry.skipped, ["ok"]);
    assert.deepEqual(retry.applied, ["broken", "after"]);
  } finally {
    cleanup();
  }
});

test("the backup hook copies the file it is about to rewrite", async () => {
  const { agentDir, cleanup } = workspace();
  const target = join(agentDir, "desktop", "settings.json");
  let backupPath = null;
  let missingBackup = "unset";
  try {
    mkdirSync(join(agentDir, "desktop"), { recursive: true });
    writeFileSync(target, '{"before":true}\n');

    await runMigrations({
      agentDir,
      now: fixedClock,
      migrations: [{
        id: "rewrite",
        version: 1,
        up: (ctx) => {
          backupPath = ctx.backup(target);
          missingBackup = ctx.backup(join(agentDir, "does-not-exist.json"));
          writeFileSync(target, '{"after":true}\n');
        },
      }],
    });

    assert.equal(missingBackup, null, "a missing file needs no backup");
    assert.ok(backupPath && backupPath.includes(".bak-"), "backup path is stamped");
    assert.equal(readFileSync(backupPath, "utf8"), '{"before":true}\n');
    assert.equal(readFileSync(target, "utf8"), '{"after":true}\n');
  } finally {
    cleanup();
  }
});

test("a corrupt ledger is treated as empty rather than blocking the app", async () => {
  const { agentDir, cleanup } = workspace();
  let runs = 0;
  try {
    mkdirSync(join(agentDir, "desktop"), { recursive: true });
    writeFileSync(migrationsStatePath(agentDir), "{ not json");

    const result = await runMigrations({
      agentDir,
      now: fixedClock,
      migrations: [{ id: "again", version: 1, up: () => { runs += 1; } }],
    });

    assert.equal(runs, 1);
    assert.deepEqual(result.applied, ["again"]);
    // The next read sees the repaired ledger.
    assert.deepEqual(readMigrationLedger(agentDir).applied.map((entry) => entry.id), ["again"]);
  } finally {
    cleanup();
  }
});

test("malformed registries are rejected before anything runs", async () => {
  assert.throws(() => validateMigrations([{ id: "a", version: 1, up: () => {} }, { id: "a", version: 2, up: () => {} }]), /duplicate migration id/);
  assert.throws(() => validateMigrations([{ id: "a", version: 1, up: () => {} }, { id: "b", version: 1, up: () => {} }]), /duplicate migration version/);
  assert.throws(() => validateMigrations([{ id: "  ", version: 1, up: () => {} }]), /id must not be empty/);
  assert.throws(() => validateMigrations([{ id: "a", version: Number.NaN, up: () => {} }]), /finite version/);

  const { agentDir, cleanup } = workspace();
  try {
    // A registry error is a code error: it throws instead of reporting a data failure.
    await assert.rejects(() => runMigrations({
      agentDir,
      migrations: [{ id: "a", version: 1, up: () => {} }, { id: "a", version: 1, up: () => {} }],
    }), /duplicate migration id/);
    assert.equal(existsSync(migrationsStatePath(agentDir)), false);
  } finally {
    cleanup();
  }
});

test("the startup runner logs a failure and remembers it without throwing", async () => {
  const { agentDir, cleanup } = workspace();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const result = await runStartupMigrations({
      agentDir,
      now: fixedClock,
      migrations: [{ id: "doomed", version: 1, up: () => { throw new Error("nope"); } }],
    });

    assert.equal(result.ok, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /migration "doomed" failed: nope/);
    assert.match(errors[0], /running without it/);
    assert.equal(getMigrationFailure()?.id, "doomed");
  } finally {
    console.error = originalError;
    cleanup();
  }
});
