ESCALATE

## Why
The work looks good. All 12 acceptance criteria are met, all four reviewers (security, ux, ui, code) PASS in round 1, and the branch merges into main without conflicts. It still needs a human because it changes how OAuth credentials are stored (credential security), and it rewrites production data on container start: every plaintext Gmail token row in the live `jobs.db` gets migrated. It also adds a build script to `orchestrator/package.json`. AGENTS.md says nothing that relaxes any of these rules.

## Acceptance criteria
1. Connect stores ciphertext only: met. `service.test.ts` asserts `v1:` `*Encrypted` keys, no plaintext keys, and no value equal to the input token (build.md).
2. Sync write-back stays encrypted: met. `gmail-sync.test.ts` covers both the encrypted-only write-back and the case where an unchanged token is not written back. The idempotency test was updated.
3. Legacy rows still work: met. Tests in `gmail-credentials.test.ts`, `gmail-sync.test.ts` and `service.test.ts` cover this.
4. Bad key degrades safely: met. With `fetch` mocked, sync reports "not connected" and disconnect does not revoke.
5. Migration encrypts, backs up and verifies: met. I re-ran `test:run -- ingestion/gmail-credentials db/migrate` myself: 21/21 passed.
6. Migration is idempotent: met (same run). Credentials stay byte-identical, no second backup is made, and a fresh DB gets no backup.
7. Failure leaves data untouched: met. With the backup forced to fail, the child process exits 0 and the rows are unchanged.
8. Other tenants and data survive: met. The test covers two tenants, an IMAP row that stays unchanged, and an unchanged `jobs` count.
9. Rollback restores plaintext: met. Rollback writes its own backup, a second run is a no-op, and with a wrong key it exits non-zero and writes nothing.
10. No token values in logs: met. Every child run's stdout and stderr is checked for the seeded token strings.
11. Rollback command exists: met. The package script is present and the AGENTS.md bullet has the key names, backup prefix and rollback command (checked in the diff).
12. CI-parity checks: met, according to the build.md Validation section (full suite: 2417 passed).

## For the human
Decide whether to let this migration run on your real data on the next container start. Things to check:
- `orchestrator/src/server/db/gmail-token-encryption.ts` and the wiring in `orchestrator/src/server/db/migrate.ts`. If the migration fails, the error is caught and the app still boots.
- `orchestrator/src/server/services/post-application/ingestion/gmail-credentials.ts`, `.../providers/gmail.ts` and `.../ingestion/gmail-sync.ts`, for the credential read and write paths.
- `orchestrator/package.json` (new `db:rollback-gmail-token-encryption` script) and `orchestrator/src/server/db/rollback-gmail-token-encryption.ts`.
- `AGENTS.md`: a new operator bullet. The spec required it, and it is not under `docs/`.
- Keep `data/credentials-key` (or `CREDENTIALS_ENCRYPTION_KEY`) together with the DB. Delete `data/jobs_pre_gmail_token_encryption_*.db` once you have confirmed the upgrade, because that file holds the plaintext tokens.
- Security review Note 1 (not blocking, worth a follow-up): SQLite can leave the old plaintext tokens in free pages of `jobs.db` and in `jobs.db-wal` after the UPDATE. Older auto and manual backups also still hold plaintext. Consider `secure_delete` / `VACUUM` in a follow-up.
- Follow-up: the `docs/` pages on self-hosting, backup and Gmail still describe plaintext storage. Update them outside the factory.
