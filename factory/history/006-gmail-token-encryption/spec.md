# Encrypt Gmail tokens at rest

> Feature: Encrypt existing Gmail access and refresh tokens at rest using credential-crypto.ts, with a safe one-off migration of existing rows (idempotent, backs up first, still reads legacy plaintext values)

Operator note from the request: the app runs in Docker with the SQLite DB on a mounted volume (`./data:/app/data`, `DATA_DIR=/app/data`), and the migration will run against real data on container start. The spec must include a tested backup and a rollback path.

## Context

**Encryption helper.** `orchestrator/src/server/infra/credential-crypto.ts` exports `encryptSecret(plain)` and `decryptSecret(cipher)`. Both are async. They use AES-256-GCM, and the stored format is `v1:<iv>:<tag>:<ciphertext>` (base64url). The key comes from `CREDENTIALS_ENCRYPTION_KEY` or from `DATA_DIR/credentials-key`, which is generated on first use. In Docker, `DATA_DIR/credentials-key` sits on the mounted `./data` volume, so it persists across container restarts. Tests live in `credential-crypto.test.ts`. They set `DATA_DIR` to a temp dir and call `vi.resetModules()`.

**Existing pattern to copy (IMAP).**
- `services/post-application/providers/imap.ts` stores `passwordEncrypted: await encryptSecret(...)` inside the integration's `credentials` JSON.
- `services/post-application/ingestion/imap-sync.ts` calls `decryptSecret` and treats a decrypt failure as "account not connected".
- `AGENTS.md` (Webhook and LLM Payload Defaults) says: "New stored integration secrets must use that helper."

**Gmail today (plaintext).** Credentials sit in `post_application_integrations.credentials`, a JSON TEXT column (`db/schema.ts`, `text("credentials", { mode: "json" })`). They are read and written through `orchestrator/src/server/repositories/post-application-integrations.ts`, which is tenant-scoped via `privateDataScopeFilter`. Plaintext `refreshToken` / `accessToken` are touched in these places:
- `services/post-application/providers/gmail.ts`:
  - `connect` writes `{ refreshToken, accessToken?, expiryDate?, scope?, tokenType?, email? }` through `upsertConnectedPostApplicationIntegration`.
  - `toPublicIntegration` derives `hasRefreshToken` / `hasAccessToken` from the plaintext keys. Raw tokens are never returned to clients.
  - `disconnect` reads `credentials.refreshToken` to call Google's revoke endpoint, then nulls the credentials.
- `services/post-application/ingestion/gmail-sync.ts`:
  - `parseGmailCredentials` reads the plaintext keys into a `GmailCredentials` object (type in `ingestion/gmail-api.ts`).
  - After `resolveGmailAccessToken` refreshes the token, `runGmailIngestionSync` writes the new tokens back in plaintext via `upsertConnectedPostApplicationIntegration`.
- `message-ingest.ts` calls `updatePostApplicationIntegrationSyncState` without `credentials`, so it does not touch tokens.

**Migrations and startup.**
- `docker-entrypoint.sh` runs `npx tsx src/server/db/migrate.ts && npm run start` on every container start. The same script is available as `npm --workspace orchestrator run db:migrate`.
- `orchestrator/src/server/db/migrate.ts` is a top-level ESM script (`"type": "module"`, so top-level `await` is available). It opens `DATA_DIR/jobs.db` with better-sqlite3, applies idempotent steps, and closes the handle at the end.
- One-off data migrations are recorded in an `app_data_migrations` table. See `seedLegacyOnboardingMigration`.
- Tests in `orchestrator/src/server/db/migrate.test.ts` run the script in a child process (`node --import tsx -e ...`) with `DATA_DIR` pointed at a temp dir, after seeding a legacy DB.

**Backups.**
- `orchestrator/src/server/services/backup/index.ts` takes online SQLite backups with better-sqlite3's `sqlite.backup(path)` into `DATA_DIR`.
- Its retention (`cleanupOldBackups`) only deletes files matching `jobs_YYYY_MM_DD.db` (auto backups).
- `listBackups` only shows files matching the auto/manual patterns.

## Requirements

1. **Stored shape.** Gmail tokens are stored as `refreshTokenEncrypted` and `accessTokenEncrypted` inside `credentials`, each produced by `encryptSecret`. The plaintext `refreshToken` / `accessToken` keys are not written by any code path after this change. The non-secret fields (`expiryDate`, `scope`, `tokenType`, `email`) stay as they are.
2. **One shared Gmail credential module.** Add `orchestrator/src/server/services/post-application/ingestion/gmail-credentials.ts`, exporting two functions:
   - `encodeStoredGmailCredentials(creds: GmailCredentials): Promise<Record<string, unknown>>` encrypts the tokens and returns the stored shape from requirement 1.
   - `decodeStoredGmailCredentials(stored: Record<string, unknown> | null): Promise<GmailCredentials | null>`. For each token it prefers the `*Encrypted` key and decrypts it with `decryptSecret`. If the `*Encrypted` key is missing, it falls back to the legacy plaintext key. It returns `null` when there is no usable refresh token, or when decryption of `refreshTokenEncrypted` fails. A failed decrypt of `accessTokenEncrypted` alone makes it return the credentials without an access token, so the token is refreshed.
3. **Writers use the encoder.** `gmailProvider.connect` (`providers/gmail.ts`) and the token write-back in `runGmailIngestionSync` (`ingestion/gmail-sync.ts`) both build `credentials` with `encodeStoredGmailCredentials`.
4. **Readers use the decoder.**
   - `runGmailIngestionSync` replaces its local `parseGmailCredentials` with `decodeStoredGmailCredentials`. When the decoder returns null, it keeps the existing "Gmail account '<key>' is not connected." error.
   - The write-back comparison (whether the access token or expiry changed) compares decrypted values, so an unchanged token does not cause a rewrite.
   - `gmailProvider.disconnect` decrypts the refresh token through the decoder to revoke it. If decoding fails, it skips the revoke, logs a warning through `logger` (no token values), and still disconnects locally.
5. **Public status unchanged.** `toPublicIntegration` in `providers/gmail.ts` reports `hasRefreshToken` / `hasAccessToken` as true when either the encrypted key or the legacy plaintext key is a non-empty string. The API response shape is unchanged, and no encrypted or plaintext token value appears in any API response.
6. **Startup migration module.** Add `orchestrator/src/server/db/gmail-token-encryption.ts`. It exports `encryptLegacyGmailTokens(sqlite, { dbPath })` and `decryptGmailTokensForRollback(sqlite, { dbPath })`. Both operate on a better-sqlite3 handle across all tenants and users. This is install-global, by design: it is a schema-level data migration, like the other steps in `migrate.ts`.
7. **Migration behaviour** (`encryptLegacyGmailTokens`):
   1. Select `post_application_integrations` rows where `provider = 'gmail'` and `credentials IS NOT NULL`. Parse the JSON. Rows that fail to parse are skipped with a warning and left untouched.
   2. A row "needs migration" if it has a non-empty plaintext `refreshToken` or `accessToken` key. If no row needs migration, it returns without creating a backup or writing anything. This is what makes repeated container starts no-ops.
   3. Otherwise it **backs up first**. It calls `sqlite.backup(<DATA_DIR>/jobs_pre_gmail_token_encryption_<UTC YYYYMMDDTHHMMSSZ>.db)`, then opens the backup read-only and verifies it. Verification passes only when `PRAGMA integrity_check` returns `ok` and the backup holds the same number of gmail `post_application_integrations` rows as the live DB.
      - The filename must not match the auto/manual backup patterns in `services/backup/index.ts`, so retention never deletes it.
      - The backup file is created with mode `0o600`, because it contains plaintext tokens.
   4. If the backup or its verification fails, it logs an error, writes nothing, and returns. Boot continues, because the legacy plaintext read path keeps Gmail working.
   5. It encrypts all values first with `encryptSecret`, which is async. Then it applies every row update inside a single `sqlite.transaction(...)`.
      - Each migrated row gets `refreshTokenEncrypted` / `accessTokenEncrypted` and has its plaintext keys removed.
      - If a row already has an `*Encrypted` key and a leftover plaintext key for the same token, the encrypted value is kept and the plaintext key is removed.
      - Any error rolls back the whole transaction.
   6. It logs one structured summary through `logger`: `{ rowsMigrated, backupFile }`. Token values are never logged.
8. **Wire into startup.** In `migrate.ts`, `await encryptLegacyGmailTokens(sqlite, { dbPath: DB_PATH })` runs after the existing tenancy compatibility steps and before `sqlite.close()`. A thrown error from this step is caught and logged, and does not `process.exit(1)`, for the same reason as 7.4.
9. **Rollback command.** `decryptGmailTokensForRollback` is the reverse operation. It runs the same backup-first-and-verify step (filename prefix `jobs_pre_gmail_token_rollback_`). It then decrypts the `*Encrypted` keys back into plaintext `refreshToken` / `accessToken` in one transaction and removes the `*Encrypted` keys. It is idempotent: if nothing is encrypted, it makes no backup and writes nothing. Unlike the startup path, any failure (backup, verification, or decryption) exits non-zero and writes nothing.
   - Expose it as `orchestrator/src/server/db/rollback-gmail-token-encryption.ts`, a small script that opens `DATA_DIR/jobs.db` and runs it.
   - Add the package script `"db:rollback-gmail-token-encryption": "tsx src/server/db/rollback-gmail-token-encryption.ts"` in `orchestrator/package.json`.
10. **AGENTS.md.** Extend the IMAP credentials bullet under "Webhook and LLM Payload Defaults" (or add a sibling bullet) with:
    - Gmail tokens are stored as `refreshTokenEncrypted` / `accessTokenEncrypted` via `ingestion/gmail-credentials.ts`.
    - Container start migrates legacy plaintext rows after writing `DATA_DIR/jobs_pre_gmail_token_encryption_<timestamp>.db`.
    - The `credentials-key` file (or `CREDENTIALS_ENCRYPTION_KEY`) must be kept with the DB.
    - The rollback procedure has two steps. First, with the new image, run `docker compose exec job-ops sh -c "cd /app/orchestrator && npm run db:rollback-gmail-token-encryption"`, then deploy the previous image. Alternatively, as a last resort, stop the container and restore the pre-migration backup file over `data/jobs.db` (removing `jobs.db-wal` / `jobs.db-shm`). Doing so loses writes made since the upgrade.
11. **Tests** (vitest, existing runner):
    - Unit tests for `gmail-credentials.ts`:
      - encode then decode round-trips.
      - The encoded output contains neither token in plaintext.
      - Legacy plaintext input decodes.
      - Encrypted keys win over plaintext keys.
      - Undecryptable `refreshTokenEncrypted` gives `null`.
    - Migration tests in `orchestrator/src/server/db/migrate.test.ts`, using its child-process pattern with a seeded legacy DB.
    - Updates to existing Gmail tests (`providers/service.test.ts`, `ingestion/gmail-sync.test.ts`, `gmail-sync.idempotency.test.ts`, `api/routes/post-application-providers.test.ts`) wherever they assert or seed the stored credential shape.

## Acceptance criteria

1. **Connect stores ciphertext only.** After a Gmail `connect`:
   - The `credentials` passed to `upsertConnectedPostApplicationIntegration` contain `refreshTokenEncrypted` (and `accessTokenEncrypted` when an access token was given) starting with `v1:`.
   - They contain no `refreshToken` / `accessToken` key.
   - No value equals the input token.

   Verify with an assertion in `orchestrator/src/server/services/post-application/providers/service.test.ts`. Run `npm --workspace orchestrator run test:run -- providers/service`.
2. **Sync write-back stays encrypted.** When `runGmailIngestionSync` refreshes the access token, the write-back stores only encrypted token keys. When the token is unchanged, no write-back happens. Verify with tests in `ingestion/gmail-sync.test.ts` or `gmail-sync.idempotency.test.ts`.
3. **Legacy rows still work before migration.** A stored row with plaintext `refreshToken` still syncs: `decodeStoredGmailCredentials` returns the token. It also reports `connected: true` with `hasRefreshToken: true` from `status`. Verify with unit tests in `gmail-credentials.test.ts` and `providers/service.test.ts`.
4. **Bad key degrades safely.** With an undecryptable `refreshTokenEncrypted`:
   - Sync throws "Gmail account '<key>' is not connected."
   - Disconnect still succeeds locally and does not call the Google revoke endpoint.

   Verify with tests that mock `fetch`.
5. **Migration encrypts, backs up and verifies.** Seed a temp `DATA_DIR/jobs.db` with a gmail row holding plaintext tokens, then run `migrate.ts`. Verify in `migrate.test.ts`:
   - The row now has `v1:` `refreshTokenEncrypted` / `accessTokenEncrypted`, no plaintext keys, and unchanged `email` / `scope` / `expiryDate`.
   - Exactly one `jobs_pre_gmail_token_encryption_*.db` exists in `DATA_DIR`.
   - That backup passes `PRAGMA integrity_check` and still holds the original plaintext row.
   - Decrypting the migrated values (with the same `DATA_DIR`) yields the original tokens.
6. **Migration is idempotent.** Running `migrate.ts` a second time on the same `DATA_DIR`:
   - leaves the row's encrypted values byte-identical (no re-encryption);
   - creates no second backup file.

   Running on a fresh DB with no gmail rows creates no backup file. Verify in `migrate.test.ts`.
7. **Migration failure leaves data untouched.** If the backup step fails, the gmail row is unchanged, no partial update exists and the script exits 0. Simulate the failure by making the backup target unwritable, or by injecting a failing backup function in a direct unit test of `encryptLegacyGmailTokens`. Verify with a test.
8. **Other tenants and other data survive.** In a seeded DB with gmail rows for two different `tenant_id`/`user_id` scopes, an IMAP row and some `jobs` rows:
   - both gmail rows are encrypted;
   - the IMAP row's `credentials` is unchanged;
   - the `jobs` row count is unchanged.

   Verify in `migrate.test.ts`.
9. **Rollback restores plaintext.** After migrating a seeded DB, running `rollback-gmail-token-encryption.ts` (child process, same `DATA_DIR`) has these effects:
   - the row contains the original plaintext `refreshToken` / `accessToken` and no `*Encrypted` keys;
   - a `jobs_pre_gmail_token_rollback_*.db` backup exists;
   - a second run makes no changes and no new backup.

   Verify in `migrate.test.ts` or a sibling `gmail-token-encryption.test.ts`.
10. **No token values in logs.** Captured log output from the migration tests contains neither seeded token string. Verify with an assertion on the child process's stdout/stderr.
11. **Rollback command exists.** `grep db:rollback-gmail-token-encryption orchestrator/package.json` matches. `AGENTS.md` contains the stored key names, the backup filename prefix and the rollback command from Requirement 10.
12. **All CI-parity checks from AGENTS.md pass:**
    - `./orchestrator/node_modules/.bin/biome ci .`
    - `npm run check:types:shared`
    - `npm --workspace orchestrator run check:types`
    - `npm --workspace gradcracker-extractor run check:types`
    - `npm --workspace ukvisajobs-extractor run check:types`
    - `npm --workspace orchestrator run build:client`
    - `npm --workspace orchestrator run test:run`

## Out of scope

- Changing `credential-crypto.ts` itself: no key rotation, new format version, or new key source.
- Encrypting anything other than Gmail `refreshToken` / `accessToken`. This includes the non-secret fields, IMAP (already encrypted), and LLM or Reactive Resume secrets.
- Any client/UI change. The public status shape is unchanged, so the UX and UI reviewers should see no visual difference.
- Changing the existing backup service, its retention or its `/api` backup routes, or making the migration backup show up in the backups UI.
- A generic data-migration framework. Use one focused module, plus the existing `app_data_migrations` pattern only if the builder needs a marker. The row scan in Requirement 7.2 is the idempotency mechanism.
- Changing the Gmail OAuth flow or the revoke behaviour beyond reading the decrypted token.
- Edits under `docs/`. Follow-up: any self-hosting, backup or Gmail integration page under `docs/` that describes credential storage or restore steps should mention the encrypted Gmail tokens, the `credentials-key` file and the rollback command.

## Assumptions

- **New `*Encrypted` key names rather than `v1:`-prefixed values in the old keys.** This mirrors IMAP's `passwordEncrypted`, and it makes legacy detection unambiguous.
- **Idempotency comes from scanning for plaintext keys on every start, not from a one-shot marker.** If someone rolls back to the old image (which writes plaintext) and then upgrades again, the next start re-migrates. A marker would skip that.
- **A failed backup or migration on startup skips encryption and lets the app boot rather than exiting.** Plaintext keeps working through the legacy read path, so a crash loop on real data is worse than staying at today's state for one more start. The rollback script, run by a human, fails hard instead.
- **The migration backup is a full DB copy in `DATA_DIR`, outside the backup-retention patterns, with mode 0600.** `DATA_DIR` is the persisted Docker volume, and the copy contains the plaintext tokens it protects. Deleting it after confirming the upgrade is left to the operator; it is noted in AGENTS.md.
- **A reverse-decrypt rollback command is provided in addition to backup restore.** Restoring the backup alone would lose jobs and applications written after the upgrade, and the mission requires the DB and its jobs to survive migrations.
- **The migration runs across all tenants and users with a raw sqlite handle.** It is an install-level schema/data migration, like the other steps in `migrate.ts`. Runtime reads and writes stay tenant-scoped through the repository.

## Mission fit
Fits: it hardens self-hosted operation in Docker and serves the success measure "no leaked secrets", while keeping the constraint that "The SQLite database and the 854 existing jobs must survive migrations".
