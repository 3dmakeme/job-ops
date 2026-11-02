STATUS: READY

# Build: Purge leftover plaintext Gmail tokens from jobs.db after encryption

## Summary
`encryptLegacyGmailTokens` now runs a purge step (`purgeFreedPlaintext`) only after the backup is verified and `applyUpdates` has committed. On the same connection it runs `PRAGMA wal_checkpoint(TRUNCATE)`, then `VACUUM`, then `PRAGMA wal_checkpoint(TRUNCATE)`. A checkpoint that reports `busy != 0` or `log != checkpointed` throws an `IncompleteCheckpointError` that carries the counts. The purge has its own try/catch. If it fails, it logs `logger.warn("Purging plaintext Gmail tokens from database file failed", { rowsMigrated, backupFile, checkpoint?, error })` and still returns the normal summary. If it succeeds, it logs `"Purged plaintext Gmail tokens from database file"` with `{ rowsMigrated, backupFile }`. The early returns (no pending rows, backup failed) come before the purge, so it cannot run on those paths. `journal_mode` is not changed. The rollback code is untouched.

Files changed:
- `orchestrator/src/server/db/gmail-token-encryption.ts`: purge step, checkpoint helper and error class.
- `orchestrator/src/server/db/migrate.test.ts`:
  - `seedLegacyDb` now sets `journal_mode = WAL`.
  - New byte-level test: "purges leftover plaintext tokens from jobs.db and its WAL".
  - The no-op test now also checks gmail-b, the job count, an unchanged directory listing and that no purge log appears, on both the repeat run and the fresh database.
- `AGENTS.md`: new bullet straight after the Gmail token bullet under "Webhook and LLM Payload Defaults".

Commits: `5265a10` feat (purge and tests), `437a143` docs (AGENTS.md note).

## Acceptance criteria
1. [x] The live DB bytes contain no seeded tokens. `npm --workspace orchestrator run test:run -- src/server/db/migrate.test.ts` gives 15/15 passed. The new test reads `jobs.db`, plus `jobs.db-wal` if it exists, with `readFileSync`, and asserts `bytes.includes(token) === false` for every `SEEDED_TOKENS` entry.
2. [x] The test fails without the purge. I commented out `purgeFreedPlaintext(sqlite);` and ran the test with `-t "purges leftover"`. Result: `× purges leftover plaintext tokens ... AssertionError: expected true to be false` (the byte assertion). I then restored the file from a copy; the committed file has the call.
3. [x] The backup still holds plaintext. The new test asserts the `jobs_pre_gmail_token_encryption_*.db` raw bytes contain every seeded token. The existing test still checks `integrity_check === "ok"`, the plaintext backup row and mode 0600, and it passes.
4. [x] Repeat runs and fresh databases are no-ops. The extended "is a no-op on repeated runs ..." test passes. Both runs exit 0 and no purge log appears. On the repeat run, the directory listing is unchanged, there is still one encryption backup, and the gmail-a/gmail-b rows and job count are unchanged. The fresh database gets no `jobs_pre_gmail_token_*` files.
5. [x] Code order: in `encryptLegacyGmailTokens`, the purge try/catch comes after `applyUpdates(sqlite, updates)` and the "Encrypted legacy Gmail tokens" log. Both `return`s (no pending rows; backup catch) come before it.
6. [x] A failed purge is only logged. The purge has its own try/catch and logs only `rowsMigrated`, `backupFile`, checkpoint counts and the sanitized error. `expectNoTokens` still passes in all migrate tests. I also ran an ad hoc check that forced `wal_checkpoint` to return `{busy:1,log:5,checkpointed:2}`: migrate logged the warning with those counts, contained no token, and exited 0.
7. [x] `git diff main -- orchestrator/src/server/db/rollback-gmail-token-encryption.ts` is empty, and `decryptGmailTokensForRollback` does not appear in the diff. The rollback tests pass.
8. [x] `grep -n "VACUUM" AGENTS.md` and `grep -n "jobs_manual_" AGENTS.md` both match line 69, the new bullet straight after the Gmail token bullet.
9. [x] All seven CI-parity checks pass (see Validation).

## Validation
- `./orchestrator/node_modules/.bin/biome ci .`: pass
- `npm run check:types:shared`: pass
- `npm --workspace orchestrator run check:types`: pass
- `npm --workspace gradcracker-extractor run check:types`: pass
- `npm --workspace ukvisajobs-extractor run check:types`: pass
- `npm --workspace orchestrator run build:client`: pass (only the existing chunk-size warning)
- `npm --workspace orchestrator run test:run`: pass, 322 files, 2418 passed, 2 skipped
- Focused: `npm --workspace orchestrator run test:run -- src/server/db/migrate.test.ts`: 15/15 pass

There are no UI changes, so no browser check was needed.

## Log
### Round 1
- Added the purge step, the WAL seed, the byte-level test and the extended no-op test, and the AGENTS.md operator note.
- Checked that the byte test fails without the purge, and checked the failed-purge path by hand.
- Declined: no changes under `docs/` or `docs-site/`, as the factory rules and the spec's out-of-scope list require. The spec's follow-up still stands: a docs-site Gmail/self-hosting page may need a line about the post-migration VACUUM and the plaintext left in older backups.
