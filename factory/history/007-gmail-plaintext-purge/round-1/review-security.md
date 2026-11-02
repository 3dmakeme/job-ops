VERDICT: PASS

## Findings
None.

## Notes
- Order is correct. In `orchestrator/src/server/db/gmail-token-encryption.ts`, `encryptLegacyGmailTokens` returns early when no rows are pending and when the backup fails, before the purge runs. The purge only runs after `backupAndVerify` succeeds and `applyUpdates` has committed. A thrown purge error or an incomplete checkpoint (`busy != 0` or `log != checkpointed`) is caught and only logged, so the committed encryption is never undone or hidden.
- Logging: the success and failure logs carry only `rowsMigrated`, `backupFile`, the checkpoint counts and the error, all passed through `@infra/logger`, which sanitizes them with `sanitizeError` / `sanitizeUnknown`. SQLite checkpoint and VACUUM errors do not include row contents. `expectNoTokens` still covers the migrate output.
- VACUUM copies only the live, already-encrypted rows, so its temp file and the rebuilt file hold no plaintext. The `-shm` file is only a WAL index and holds no record data. `journal_mode` is unchanged.
- Residual exposure (out of scope by the spec, and the AGENTS.md note now documents it): installs that migrated under the previous release keep their leftover plaintext bytes, because the purge only runs in a run that migrates rows. Backups (`jobs_YYYY_MM_DD.db`, `jobs_manual_*.db`, `jobs_pre_gmail_token_*`) still hold plaintext. Freed filesystem blocks below SQLite are not covered. A follow-up one-off purge for already-migrated installs would close the first gap.
- The test inserts fake token strings only (`SEEDED_TOKENS`). No secrets, `.env` values or new dependencies were added.
- secure-endpoint: no concerns. Checked items 1-13. There is no endpoint, route, action or client input in scope: this is a startup migration step with no outside input. Items 1-9 and 12-13 are n/a. Item 10: it runs as the container user that already owns `DATA_DIR/jobs.db`, and VACUUM needs only write access to the DB file and temp space, which it already has. Item 11: no secrets were added.
