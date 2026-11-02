/**
 * Rollback script - decrypts stored Gmail tokens back to the legacy plaintext
 * keys so a previous image can read them. Backs up and verifies first.
 */

import { join } from "node:path";
import { logger } from "@infra/logger";
import Database from "better-sqlite3";
import { getDataDir } from "../config/dataDir";
import { decryptGmailTokensForRollback } from "./gmail-token-encryption";

const DB_PATH = join(getDataDir(), "jobs.db");

const sqlite = new Database(DB_PATH, { fileMustExist: true });
try {
  await decryptGmailTokensForRollback(sqlite, { dbPath: DB_PATH });
} catch (error) {
  logger.error("Gmail token rollback failed; no rows were changed", error);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
