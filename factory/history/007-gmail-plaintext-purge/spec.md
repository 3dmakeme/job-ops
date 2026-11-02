# Purge leftover plaintext Gmail tokens from jobs.db after encryption

> Feature: Purge old plaintext Gmail tokens from SQLite after the encryption migration: after gmail-token-encryption.ts updates rows, remove leftover plaintext from jobs.db free pages and the WAL (for example PRAGMA wal_checkpoint(TRUNCATE) plus VACUUM, or secure_delete for that connection), only after the verified backup exists and the update has committed; idempotent, no-op when nothing was migrated, tests that the old token string is no longer present in the database file bytes, and an AGENTS.md operator note that older jobs_*.db backups still hold plaintext until retention removes them

## Context

- `orchestrator/src/server/db/gmail-token-encryption.ts` holds the one-off data migration. `encryptLegacyGmailTokens(sqlite, { dbPath })`:
  1. reads Gmail rows from `post_application_integrations` that still have plaintext `refreshToken` / `accessToken`. If there are none it returns `{ rowsMigrated: 0, backupFile: null }` straight away.
  2. writes and verifies `jobs_pre_gmail_token_encryption_<timestamp>.db` with `backupAndVerify` (mode 0600, `integrity_check`, Gmail row count). If the backup fails it logs and returns `rowsMigrated: 0`.
  3. encrypts the tokens and commits every row update in one transaction (`applyUpdates`, which uses `sqlite.transaction(...)()`).
  4. logs `"Encrypted legacy Gmail tokens"` with `{ rowsMigrated, backupFile }` and returns that summary.

  Nothing removes the old plaintext bytes afterwards. SQLite leaves the old record contents in page free space, on freelist pages and in WAL frames.
- `orchestrator/src/server/db/migrate.ts` opens `new Database(DB_PATH)` on `DATA_DIR/jobs.db`. Near the end of the file it calls `encryptLegacyGmailTokens` inside a try/catch, so a failure only logs and startup carries on. Then it calls `sqlite.close()`. `docker-entrypoint.sh` runs `migrate.ts` before `npm run start`, so no other app connection is open at that point.
- `orchestrator/src/server/db/index.ts` (the app's runtime connection) sets `journal_mode = WAL`. That setting is stored in the database file, so on an existing install the migrate connection also runs in WAL mode and a `jobs.db-wal` file can exist.
- `orchestrator/src/server/db/rollback-gmail-token-encryption.ts` / `decryptGmailTokensForRollback` deliberately write plaintext back. This job leaves them alone.
- Tests: `orchestrator/src/server/db/migrate.test.ts` has `describe.sequential("gmail token encryption migration", ...)`. It uses `seedLegacyDb()` (runs migrate in a temp `DATA_DIR`, then inserts two Gmail rows with plaintext tokens `SEEDED_TOKENS` across two tenants, plus an IMAP row and jobs), `runMigrate(dataDir)` (spawns `migrate.ts` via tsx), `readCredentials` and `filesWithPrefix`. The new tests belong in this block and should reuse these helpers.
- Backup retention: `orchestrator/src/server/services/backup/index.ts`, `cleanupOldBackups`, deletes only automatic backups (`jobs_YYYY_MM_DD.db`) beyond `maxCount` (default 5). Manual backups (`jobs_manual_*.db`) and the `jobs_pre_gmail_token_*` files are never deleted automatically.
- `AGENTS.md`, section "Webhook and LLM Payload Defaults", has the Gmail token encryption operator bullet. The new note goes there.

## Requirements

1. In `gmail-token-encryption.ts`, add a purge step that `encryptLegacyGmailTokens` runs only after both of these:
   - `backupAndVerify` has returned a verified backup file
   - `applyUpdates` has committed with at least one row updated

   It never runs on the early-return paths: no pending rows, or the backup failed.
2. The purge removes leftover plaintext from both the main database file and the WAL. It runs these on the same connection, in this order:
   1. `PRAGMA wal_checkpoint(TRUNCATE)`
   2. `VACUUM`
   3. `PRAGMA wal_checkpoint(TRUNCATE)`

   The second checkpoint is needed because in WAL mode the VACUUM output goes to the WAL first. On a database that is not in WAL mode the checkpoints are harmless no-ops. Do not change the database's `journal_mode`.
3. A failed purge must not undo or hide the committed migration. This covers a thrown error and a checkpoint that reports `busy = 1` or does not checkpoint every frame. In that case:
   - log a warning or error through `@infra/logger` with structured, token-free fields (`rowsMigrated`, `backupFile`, and the checkpoint result counts if relevant)
   - still return the normal `{ rowsMigrated, backupFile }` summary
   - let `migrate.ts` still exit 0
4. A successful purge is logged through `@infra/logger` (for example `"Purged plaintext Gmail tokens from database file"`) with no token values.
5. The purge is idempotent and is skipped when nothing was migrated. Running migrate again on an already-encrypted database, or on a database with no Gmail rows, does no checkpoint/VACUUM work, creates no files and changes no rows. The existing early return gives this for free; keep it that way.
6. `decryptGmailTokensForRollback` and the rollback script stay unchanged.
7. Add tests in the `gmail token encryption migration` block of `orchestrator/src/server/db/migrate.test.ts`:
   - The legacy seed puts the database into WAL mode the way production does (`journal_mode = WAL`). Set it either in `seedLegacyDb` or in the new test's own setup.
   - After `runMigrate` on the seeded legacy database, read the raw bytes of `jobs.db`, and of `jobs.db-wal` if it exists, with `readFileSync`. Assert that none of `SEEDED_TOKENS` appears in them (`Buffer.includes` / `indexOf === -1`).
   - In the same test, assert that the verified `jobs_pre_gmail_token_encryption_*.db` backup's raw bytes still contain the plaintext tokens. This shows the backup was taken before the purge and the purge did not touch it.
   - Assert that the second-run and no-Gmail-rows cases still leave rows and backup counts unchanged. Extending the existing "is a no-op on repeated runs ..." test is enough.
8. Update `AGENTS.md`, in the existing Gmail token bullet (or as a new bullet straight after it under "Webhook and LLM Payload Defaults"):
   - After a migration that encrypted rows, startup checkpoints the WAL and runs `VACUUM` so `jobs.db` / `jobs.db-wal` no longer hold the old plaintext tokens.
   - Older database backups still hold plaintext tokens. Automatic `jobs_YYYY_MM_DD.db` backups age out through backup retention (`maxCount`). Manual `jobs_manual_*.db` backups and the `jobs_pre_gmail_token_*` files are never removed automatically, so operators should delete them once they no longer need them.
9. All seven CI-parity checks in `AGENTS.md` pass.

## Acceptance criteria

1. After migrating a legacy WAL-mode database, the raw bytes of `DATA_DIR/jobs.db` (and of `jobs.db-wal`, if present) contain none of the seeded plaintext tokens. Verify: `npm --workspace orchestrator run test:run -- src/server/db/migrate.test.ts` passes, including the new byte-level test.
2. The new byte-level test fails without the purge. Verify: temporarily comment out the purge call in `encryptLegacyGmailTokens` and rerun the focused test. The byte assertion fails. Then restore the call.
3. The `jobs_pre_gmail_token_encryption_*.db` backup still holds the plaintext tokens and still passes `integrity_check`. Verify: the new test asserts the token bytes are present, and the existing test still checks the backup row and mode 0600.
4. A repeat migrate run, and a migrate run on a fresh database with no Gmail rows, both exit 0 and create no extra `jobs_pre_gmail_token_*` files. Verify: the existing "is a no-op on repeated runs ..." test passes.
5. Code order: the purge runs only after `backupAndVerify` succeeds and after `applyUpdates` returns, and it is unreachable on both early-return paths. Verify by reading `encryptLegacyGmailTokens` in `orchestrator/src/server/db/gmail-token-encryption.ts`.
6. A failed purge is only logged and does not throw out of `encryptLegacyGmailTokens`. Verify by reading the code: the purge is wrapped in its own try/catch, and its logs carry no token values. `migrate.test.ts` checks that no seeded token appears in migrate output (`expectNoTokens`), and that check still passes.
7. `git diff main -- orchestrator/src/server/db/rollback-gmail-token-encryption.ts` is empty, and `decryptGmailTokensForRollback` is unchanged. The rollback test still passes.
8. `AGENTS.md` contains the operator note from requirement 8. Verify: `grep -n "VACUUM" AGENTS.md` and `grep -n "jobs_manual_" AGENTS.md` both match lines in the Gmail token section.
9. From the repo root, all of these pass:
   - `./orchestrator/node_modules/.bin/biome ci .`
   - `npm run check:types:shared`
   - `npm --workspace orchestrator run check:types`
   - `npm --workspace gradcracker-extractor run check:types`
   - `npm --workspace ukvisajobs-extractor run check:types`
   - `npm --workspace orchestrator run build:client`
   - `npm --workspace orchestrator run test:run`

## Out of scope

- Purging or rewriting any backup file: `jobs_*.db`, `jobs_manual_*.db` or `jobs_pre_gmail_token_*`. Changing backup retention, or deleting backups automatically.
- Running VACUUM or a checkpoint on every startup, or when no rows were migrated in this run. That includes installs that migrated under the previous release and whose file may still hold plaintext. That is a possible follow-up, not this job.
- Turning on `secure_delete` globally, or in `db/index.ts`. Changing `journal_mode`.
- Purging after the rollback (`decryptGmailTokensForRollback` writes plaintext on purpose).
- Overwriting freed disk blocks below SQLite (filesystem, SSD wear-levelling, Docker volume snapshots).
- Changes under `docs/` or `docs-site/`. Follow-up: if a self-hosting or Gmail integration page in `docs-site` describes the token encryption upgrade, it may need a line about the post-migration VACUUM and the plaintext in older backups.

## Assumptions

- **The purge is `wal_checkpoint(TRUNCATE)`, then `VACUUM`, then `wal_checkpoint(TRUNCATE)`, not `secure_delete`.** VACUUM rebuilds the file, so it clears free space inside pages and freelist pages. `secure_delete` alone would not clear plaintext already sitting in older WAL frames or pages.
- **The purge runs only in the run that actually migrated rows.** The request says "no-op when nothing was migrated". So an install that migrated before this change keeps its leftover bytes until the next migration or a manual VACUUM.
- **A failed purge logs and continues.** This matches how `migrate.ts` already treats the encryption step: tokens are already encrypted in the live rows, so blocking boot would cost more than it protects.
- **VACUUM at startup is acceptable.** It needs temporary free disk space of about the database's size and briefly lengthens startup. The DB is small (around 850 jobs), and the step runs once per migration.
- **"Retention" in the operator note means the automatic backup `maxCount` rotation.** The note states plainly that manual and pre-migration backups are never removed automatically.

## Mission fit
Fits: serves the success measure "no leaked secrets" and "Self-hosting and operating the app in Docker", and keeps the existing SQLite data intact through the migration.
