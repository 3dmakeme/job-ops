STATUS: READY

# Build: Encrypt Gmail tokens at rest

## Summary
Gmail `refreshToken` / `accessToken` are now stored as `refreshTokenEncrypted` / `accessTokenEncrypted` (AES-256-GCM via `infra/credential-crypto.ts`). A shared codec (`ingestion/gmail-credentials.ts`) encodes on every write (connect, sync write-back) and decodes on every read (sync, disconnect revoke), still accepting legacy plaintext rows. `toPublicIntegration` reports `hasRefreshToken` / `hasAccessToken` from either key; the API shape is unchanged. On container start, `migrate.ts` runs `encryptLegacyGmailTokens`: it scans all gmail rows (install-wide), and only if a plaintext token exists it writes `DATA_DIR/jobs_pre_gmail_token_encryption_<YYYYMMDDTHHMMSSZ>.db` (mode 0600, created with `wx`), verifies it (`integrity_check` = ok and same gmail row count), then encrypts all values and applies the updates in one transaction. A backup failure logs an error, deletes the partial backup file, writes nothing and lets boot continue; any other thrown error is caught in `migrate.ts` and logged. `decryptGmailTokensForRollback` is the reverse (backup prefix `jobs_pre_gmail_token_rollback_`), run through `npm run db:rollback-gmail-token-encryption`, which sets exit code 1 on any failure and writes no rows.

Files changed (worktree `orchestrator/` unless noted):
- `src/server/services/post-application/ingestion/gmail-credentials.ts` (new)
- `src/server/services/post-application/ingestion/gmail-credentials.test.ts` (new)
- `src/server/services/post-application/ingestion/gmail-sync.ts`
- `src/server/services/post-application/ingestion/gmail-sync.test.ts`
- `src/server/services/post-application/ingestion/gmail-sync.idempotency.test.ts`
- `src/server/services/post-application/providers/gmail.ts`
- `src/server/services/post-application/providers/service.test.ts`
- `src/server/db/gmail-token-encryption.ts` (new)
- `src/server/db/rollback-gmail-token-encryption.ts` (new)
- `src/server/db/migrate.ts`
- `src/server/db/migrate.test.ts`
- `package.json` (script `db:rollback-gmail-token-encryption`)
- `AGENTS.md` (repo root)

## Acceptance criteria
1. [x] Connect stores ciphertext only: `service.test.ts` "connects gmail and persists credentials…" asserts the `credentials` passed to `upsertConnectedPostApplicationIntegration` have `refreshTokenEncrypted` / `accessTokenEncrypted` matching `/^v1:/`, no `refreshToken` / `accessToken` keys, no value equal to the input tokens, and the response does not contain the ciphertext. `npm --workspace orchestrator run test:run -- providers/service` passed.
2. [x] Sync write-back stays encrypted: `gmail-sync.test.ts` "writes refreshed tokens back encrypted only" (expired token, mocked refresh) asserts the write-back keys are exactly `accessTokenEncrypted, email, expiryDate, refreshTokenEncrypted`, no plaintext, and decode returns the new token. "skips the write-back when the decrypted token is unchanged" asserts no upsert and no token refresh call. `gmail-sync.idempotency.test.ts` now seeds encrypted credentials and asserts no write-back. Passed.
3. [x] Legacy rows still work: `gmail-credentials.test.ts` "decodes legacy plaintext credentials"; `gmail-sync.test.ts` "syncs a legacy plaintext row"; `service.test.ts` "reports a legacy plaintext gmail row as connected" (`connected: true`, `hasRefreshToken: true`, token not in response). Passed.
4. [x] Bad key degrades safely: `gmail-sync.test.ts` "treats an undecryptable refresh token as not connected" (rejects with "Gmail account 'default' is not connected.", `fetch` never called); `service.test.ts` "disconnects locally without revoking when the refresh token cannot be decrypted" (mocked `fetch` not called, `disconnectPostApplicationIntegration` called, `connected: false`). Disconnect with a valid encrypted token sends `token=refresh-token` to the revoke endpoint. Passed.
5. [x] Migration encrypts, backs up and verifies: `migrate.test.ts` "encrypts plaintext rows across tenants after a verified backup" runs `migrate.ts` in a child process on a seeded DB: rows have `v1:` encrypted keys, no plaintext keys, `email`/`scope`/`expiryDate` unchanged; exactly one `jobs_pre_gmail_token_encryption_\d{8}T\d{6}Z.db`, mode 0600, `integrity_check` ok and still holding the plaintext row; decrypting with the same `DATA_DIR` gives the original tokens. Passed.
6. [x] Idempotent: "is a no-op on repeated runs and on databases without gmail rows": second run leaves credentials byte-identical and still one backup; a fresh DB produces no `jobs_pre_gmail_token_*` file. Passed.
7. [x] Failure leaves data untouched: "leaves rows untouched and still boots when the backup fails" patches `Database.prototype.backup` to reject in the child, then imports `migrate.ts`: exit status 0, error logged, both gmail rows unchanged, no backup file left. Passed.
8. [x] Other tenants and data survive: the AC5 test seeds gmail rows for `tenant_default/user_a` and `tenant_b/user_b`, an IMAP row and two `jobs` rows: both gmail rows encrypted, IMAP `credentials` deep-equal to the seed, `jobs` count unchanged. Passed.
9. [x] Rollback restores plaintext: "rolls encrypted rows back to plaintext after a verified backup" runs `rollback-gmail-token-encryption.ts` in a child: rows equal the original plaintext JSON, no `*Encrypted` keys, one `jobs_pre_gmail_token_rollback_*.db` (0600); a second run changes nothing and creates no new backup. Extra: "exits non-zero and writes nothing when rollback cannot decrypt" (wrong `credentials-key`) exits non-zero and leaves the row unchanged. Passed.
10. [x] No token values in logs: every migration/rollback child run's stdout+stderr is asserted not to contain any of the four seeded token strings (`expectNoTokens`). Manual run showed the summary log `{"rowsMigrated":1,"backupFile":".../jobs_pre_gmail_token_encryption_20261102T232127Z.db"}`. Passed.
11. [x] `grep -n db:rollback-gmail-token-encryption orchestrator/package.json` prints line 24. `AGENTS.md` (Webhook and LLM Payload Defaults) now has a Gmail bullet with `refreshTokenEncrypted` / `accessTokenEncrypted`, `jobs_pre_gmail_token_encryption_<timestamp>.db`, the `credentials-key` note, the `docker compose exec job-ops sh -c "cd /app/orchestrator && npm run db:rollback-gmail-token-encryption"` command plus "then deploy the previous image", and the last-resort restore (removing `jobs.db-wal` / `jobs.db-shm`, loses writes since the upgrade). The compose service name `job-ops` was checked in `docker-compose.yml`.
12. [x] All CI-parity checks pass (see Validation).

No UI change, so no browser check was needed.

## Validation
Run from the worktree root on Node v22.23.4:
- `./orchestrator/node_modules/.bin/biome ci .`: passed (1112 files, no issues)
- `npm run check:types:shared`: passed
- `npm --workspace orchestrator run check:types`: passed
- `npm --workspace gradcracker-extractor run check:types`: passed
- `npm --workspace ukvisajobs-extractor run check:types`: passed
- `npm --workspace orchestrator run build:client`: passed
- `npm --workspace orchestrator run test:run`: passed (322 files, 2417 passed, 2 skipped)
- Targeted: `test:run -- providers/service ingestion/gmail-credentials`, `-- ingestion/gmail-sync`, `-- db/migrate`: all passed.
- Manual smoke: `migrate.ts` on a scratch `DATA_DIR` with a plaintext gmail row, then `npm run db:rollback-gmail-token-encryption`; both logged one summary line, backup files were `-rw-------`.

## Log
### Round 1
- Added `gmail-credentials.ts` (encode/decode) and switched `gmailProvider.connect`, `disconnect`, `toPublicIntegration` and `runGmailIngestionSync` (read and write-back) to it. Disconnect logs a warning with no token values and skips revoke when a stored refresh token can't be decoded.
- Added `db/gmail-token-encryption.ts` with `encryptLegacyGmailTokens` and `decryptGmailTokensForRollback`, wired the first into `migrate.ts` (top-level `await`, errors caught and logged), and added the rollback script and package script.
- Choices to flag for review: a backup that fails to write or verify is deleted, so a failed start leaves no empty or partial `jobs_pre_*` file and the next start tries again. The backup goes next to `dbPath` (equal to `DATA_DIR/jobs.db` in both callers). The summary log is only written when rows were migrated, so ordinary starts stay quiet. Both functions return `{ rowsMigrated | rowsRolledBack, backupFile }`.
- Tests: new `gmail-credentials.test.ts`; Gmail tests updated in `service.test.ts`, `gmail-sync.test.ts` and `gmail-sync.idempotency.test.ts`; five child-process migration/rollback tests added to `migrate.test.ts`. `api/routes/post-application-providers.test.ts` only checks the connect input payload sent to a mocked provider, not the stored shape, so it needed no change.
- Updated `AGENTS.md` as Requirement 10 asks. Nothing under `docs/` was touched. The spec's follow-up for docs pages on self-hosting, backups and Gmail is left for the product docs, outside the factory.
- Commits: `2bb2d84` feat: store Gmail tokens encrypted via credential-crypto; `526da1d` feat: migrate legacy plaintext Gmail tokens on startup with backup and rollback; `e08d561` docs: note Gmail token encryption and rollback in AGENTS.md.
