/**
 * One-off data migration that moves stored Gmail tokens between the legacy
 * plaintext keys and the AES-256-GCM encrypted keys. Runs install-wide (all
 * tenants and users) against a raw better-sqlite3 handle, like the other
 * steps in migrate.ts.
 */

import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decryptSecret, encryptSecret } from "@infra/credential-crypto";
import { logger } from "@infra/logger";
import Database from "better-sqlite3";

type SqliteHandle = Database.Database;

type GmailRow = {
  id: string;
  credentials: Record<string, unknown>;
};

const TOKEN_KEYS = [
  { plainKey: "refreshToken", encryptedKey: "refreshTokenEncrypted" },
  { plainKey: "accessToken", encryptedKey: "accessTokenEncrypted" },
] as const;

const ENCRYPTION_BACKUP_PREFIX = "jobs_pre_gmail_token_encryption_";
const ROLLBACK_BACKUP_PREFIX = "jobs_pre_gmail_token_rollback_";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function countGmailRows(sqlite: SqliteHandle): number {
  const row = sqlite
    .prepare(
      "SELECT count(*) AS count FROM post_application_integrations WHERE provider = 'gmail'",
    )
    .get() as { count: number };
  return row.count;
}

function readGmailRows(sqlite: SqliteHandle): GmailRow[] {
  const rows = sqlite
    .prepare(
      "SELECT id, credentials FROM post_application_integrations WHERE provider = 'gmail' AND credentials IS NOT NULL",
    )
    .all() as Array<{ id: string; credentials: string }>;

  const parsed: GmailRow[] = [];
  for (const row of rows) {
    let credentials: unknown;
    try {
      credentials = JSON.parse(row.credentials);
    } catch {
      credentials = null;
    }
    if (
      !credentials ||
      typeof credentials !== "object" ||
      Array.isArray(credentials)
    ) {
      logger.warn("Skipping Gmail integration with unreadable credentials", {
        integrationId: row.id,
      });
      continue;
    }
    parsed.push({
      id: row.id,
      credentials: credentials as Record<string, unknown>,
    });
  }
  return parsed;
}

function backupTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

// Writes a full online copy of the live DB next to it and checks it before
// any row is changed. The copy holds secrets, so it is created owner-only.
async function backupAndVerify(
  sqlite: SqliteHandle,
  dbPath: string,
  prefix: string,
): Promise<string> {
  const backupFile = join(dirname(dbPath), `${prefix}${backupTimestamp()}.db`);
  writeFileSync(backupFile, "", { flag: "wx", mode: 0o600 });
  try {
    await sqlite.backup(backupFile);
    chmodSync(backupFile, 0o600);

    const backup = new Database(backupFile, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const integrity = backup.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") {
        throw new Error("Backup failed PRAGMA integrity_check.");
      }
      if (countGmailRows(backup) !== countGmailRows(sqlite)) {
        throw new Error("Backup Gmail integration row count does not match.");
      }
    } finally {
      backup.close();
    }
  } catch (error) {
    rmSync(backupFile, { force: true });
    throw error;
  }
  return backupFile;
}

function applyUpdates(
  sqlite: SqliteHandle,
  updates: Array<{ id: string; credentials: Record<string, unknown> }>,
): void {
  const update = sqlite.prepare(
    "UPDATE post_application_integrations SET credentials = ? WHERE id = ?",
  );
  sqlite.transaction(() => {
    for (const row of updates) {
      update.run(JSON.stringify(row.credentials), row.id);
    }
  })();
}

export async function encryptLegacyGmailTokens(
  sqlite: SqliteHandle,
  options: { dbPath: string },
): Promise<{ rowsMigrated: number; backupFile: string | null }> {
  const pending = readGmailRows(sqlite).filter((row) =>
    TOKEN_KEYS.some(({ plainKey }) =>
      isNonEmptyString(row.credentials[plainKey]),
    ),
  );
  if (pending.length === 0) return { rowsMigrated: 0, backupFile: null };

  let backupFile: string;
  try {
    backupFile = await backupAndVerify(
      sqlite,
      options.dbPath,
      ENCRYPTION_BACKUP_PREFIX,
    );
  } catch (error) {
    logger.error(
      "Gmail token encryption skipped: pre-migration backup failed",
      error,
    );
    return { rowsMigrated: 0, backupFile: null };
  }

  const updates: GmailRow[] = [];
  for (const row of pending) {
    const credentials = { ...row.credentials };
    for (const { plainKey, encryptedKey } of TOKEN_KEYS) {
      const plain = credentials[plainKey];
      if (
        !isNonEmptyString(credentials[encryptedKey]) &&
        isNonEmptyString(plain)
      ) {
        credentials[encryptedKey] = await encryptSecret(plain);
      }
      delete credentials[plainKey];
    }
    updates.push({ id: row.id, credentials });
  }

  applyUpdates(sqlite, updates);

  const summary = { rowsMigrated: updates.length, backupFile };
  logger.info("Encrypted legacy Gmail tokens", summary);
  return summary;
}

export async function decryptGmailTokensForRollback(
  sqlite: SqliteHandle,
  options: { dbPath: string },
): Promise<{ rowsRolledBack: number; backupFile: string | null }> {
  const pending = readGmailRows(sqlite).filter((row) =>
    TOKEN_KEYS.some(({ encryptedKey }) =>
      isNonEmptyString(row.credentials[encryptedKey]),
    ),
  );
  if (pending.length === 0) return { rowsRolledBack: 0, backupFile: null };

  const backupFile = await backupAndVerify(
    sqlite,
    options.dbPath,
    ROLLBACK_BACKUP_PREFIX,
  );

  const updates: GmailRow[] = [];
  for (const row of pending) {
    const credentials = { ...row.credentials };
    for (const { plainKey, encryptedKey } of TOKEN_KEYS) {
      const encrypted = credentials[encryptedKey];
      if (isNonEmptyString(encrypted)) {
        credentials[plainKey] = await decryptSecret(encrypted);
      }
      delete credentials[encryptedKey];
    }
    updates.push({ id: row.id, credentials });
  }

  applyUpdates(sqlite, updates);

  const summary = { rowsRolledBack: updates.length, backupFile };
  logger.info("Decrypted Gmail tokens for rollback", summary);
  return summary;
}
