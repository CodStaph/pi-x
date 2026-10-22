/**
 * Data migrations for the files pi-web owns (stage D of
 * docs/architecture-improvement-plan.zh-CN.md).
 *
 * pi's own session files and `settings.json` are pi's to migrate; the SDK already
 * rewrites a session file into the current format when it opens one. What this
 * module covers is the JSON pi-web itself writes into `<agentDir>/`: the desktop
 * preferences, `agents/settings.json`, and any future file whose shape changes.
 *
 * The framework exists before the first migration does. That is deliberate: the
 * expensive part of a format change is not the transformation, it is deciding
 * afterwards — when user data is already in the old shape and several writers
 * disagree — what it used to mean. `MIGRATIONS` is empty today (no pi-web-owned
 * file has needed a shape change yet); adding one is the documented four-step
 * below.
 *
 * Rules the runner enforces, and why:
 *
 *   - **Idempotent by ledger.** `<agentDir>/desktop/migrations.json` records the
 *     ids that already ran, so a restart never re-applies one. An applied entry is
 *     written *after* each successful migration, not once at the end, so a crash
 *     mid-sequence does not replay finished work.
 *   - **Forward only, ordered by `version`.** There is no `down()`: rolling back a
 *     data change is a new migration. Versions must be unique — a duplicate is a
 *     configuration error and throws before anything runs.
 *   - **A failure stops the sequence and keeps user data intact.** The failed
 *     migration is not recorded, so it runs again after the fix; later migrations
 *     are not attempted; pi-web keeps running without them (the caller only logs).
 *     `ctx.backup()` copies a file to `<path>.bak-<timestamp>` before it is
 *     touched — the migration decides which files it is about to rewrite.
 *   - **A corrupt ledger is treated as empty**, because refusing to start over a
 *     metadata file would be worse than re-running idempotent migrations.
 *
 * How to add a migration:
 *   1. write `up()` so it checks the current shape and returns early when the new
 *      shape is already there (the ledger can be lost);
 *   2. call `ctx.backup(path)` for every file it rewrites;
 *   3. give it the next unused `version` and a stable `id` (the ledger keys on id);
 *   4. add a test that runs it twice and asserts the second run is a no-op.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";

/** What a migration may do to the filesystem, and nothing else. */
export interface MigrationContext {
  readonly agentDir: string;
  /** Copy a file before rewriting it; returns the backup path, or null when absent. */
  backup(path: string): string | null;
}

export interface Migration {
  /** Stable identity recorded in the ledger; renaming it re-runs the migration. */
  readonly id: string;
  /** Ascending order across the whole registry; must be unique. */
  readonly version: number;
  up(ctx: MigrationContext): Promise<void> | void;
}

interface LedgerEntry {
  id: string;
  version: number;
  at: string;
}

export interface MigrationLedger {
  schemaVersion: 1;
  applied: LedgerEntry[];
}

export interface MigrationRunResult {
  ok: boolean;
  applied: string[];
  skipped: string[];
  failed?: { id: string; error: string };
}

/**
 * The registry. Empty on purpose — see the module comment. Add entries with the
 * next unused `version`; `validateMigrations()` rejects duplicates at runtime and
 * `lib/migrations/index.test.mjs` pins the rules.
 */
export const MIGRATIONS: readonly Migration[] = [];

export function migrationsStatePath(agentDir: string): string {
  return join(agentDir, "desktop", "migrations.json");
}

/** Read the ledger; a missing or malformed file reads as "nothing applied yet". */
export function readMigrationLedger(agentDir: string): MigrationLedger {
  const path = migrationsStatePath(agentDir);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { schemaVersion: 1, applied: [] };
    const applied = (parsed as { applied?: unknown }).applied;
    if (!Array.isArray(applied)) return { schemaVersion: 1, applied: [] };
    return {
      schemaVersion: 1,
      applied: applied.flatMap((entry): LedgerEntry[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const { id, version, at } = entry as { id?: unknown; version?: unknown; at?: unknown };
        if (typeof id !== "string" || typeof version !== "number") return [];
        return [{ id, version, at: typeof at === "string" ? at : "" }];
      }),
    };
  } catch {
    return { schemaVersion: 1, applied: [] };
  }
}

export function writeMigrationLedger(agentDir: string, ledger: MigrationLedger): void {
  const path = migrationsStatePath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Reject a registry that could not run deterministically. Throws. */
export function validateMigrations(migrations: readonly Migration[]): void {
  const ids = new Set<string>();
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (!migration.id.trim()) throw new Error("migration id must not be empty");
    if (!Number.isFinite(migration.version)) throw new Error(`migration ${migration.id} has no finite version`);
    if (ids.has(migration.id)) throw new Error(`duplicate migration id: ${migration.id}`);
    if (versions.has(migration.version)) throw new Error(`duplicate migration version: ${migration.version}`);
    ids.add(migration.id);
    versions.add(migration.version);
  }
}

function createContext(agentDir: string, now: () => Date): MigrationContext {
  return {
    agentDir,
    backup(path: string): string | null {
      if (!existsSync(path)) return null;
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      const target = `${path}.bak-${stamp}`;
      copyFileSync(path, target);
      return target;
    },
  };
}

export interface RunMigrationsOptions {
  agentDir?: string;
  migrations?: readonly Migration[];
  /** Injectable clock for tests. */
  now?: () => Date;
}

/**
 * Apply every pending migration in version order.
 *
 * Never throws for a migration failure (that is a data problem, reported in the
 * result); throws only for a malformed registry, which is a code problem.
 */
export async function runMigrations(options: RunMigrationsOptions = {}): Promise<MigrationRunResult> {
  const migrations = options.migrations ?? MIGRATIONS;
  validateMigrations(migrations);
  if (migrations.length === 0) return { ok: true, applied: [], skipped: [] };

  const agentDir = options.agentDir ?? getAgentDir();
  const now = options.now ?? (() => new Date());
  const ledger = readMigrationLedger(agentDir);
  const done = new Set(ledger.applied.map((entry) => entry.id));
  const result: MigrationRunResult = { ok: true, applied: [], skipped: [] };

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of ordered) {
    if (done.has(migration.id)) {
      result.skipped.push(migration.id);
      continue;
    }
    try {
      await migration.up(createContext(agentDir, now));
    } catch (error) {
      result.ok = false;
      result.failed = {
        id: migration.id,
        error: error instanceof Error ? error.message : String(error),
      };
      // The ledger keeps the completed prefix only: this migration runs again
      // after the fix, and the ones after it are not attempted.
      return result;
    }
    ledger.applied.push({ id: migration.id, version: migration.version, at: now().toISOString() });
    // Per-migration write, so a crash later in the sequence does not replay this.
    writeMigrationLedger(agentDir, ledger);
    result.applied.push(migration.id);
  }

  return result;
}

declare global {
  var __piWebMigrationFailure: { id: string; error: string; at: string } | undefined;
}

/** The last failed migration of this process, for diagnostics. */
export function getMigrationFailure(): { id: string; error: string; at: string } | undefined {
  return globalThis.__piWebMigrationFailure;
}

/**
 * Boot-time entry point. A failure is logged, never fatal: pi-web keeps running
 * without the migration rather than refusing to start over a data file.
 */
export async function runStartupMigrations(options: RunMigrationsOptions = {}): Promise<MigrationRunResult> {
  const result = await runMigrations(options);
  if (!result.ok && result.failed) {
    globalThis.__piWebMigrationFailure = { ...result.failed, at: new Date().toISOString() };
    console.error(
      `[pi-web] migration "${result.failed.id}" failed: ${result.failed.error}`
        + " — pi-web is running without it; fix the file and restart.",
    );
  }
  return result;
}
