# Encrypt Gmail tokens at rest
Outcome: merged 2026-11-02 after 1 review round (0 reworks) · Mission fit: Fits

> Feature: Encrypt existing Gmail access and refresh tokens at rest using credential-crypto.ts, with a safe one-off migration of existing rows (idempotent, backs up first, still reads legacy plaintext values)

## What shipped
Gmail OAuth tokens were stored as plaintext in `post_application_integrations.credentials`, unlike IMAP passwords. They are now stored as `refreshTokenEncrypted` / `accessTokenEncrypted` (AES-256-GCM via `credential-crypto.ts`). A shared codec (`orchestrator/src/server/services/post-application/ingestion/gmail-credentials.ts`) is used by connect, disconnect and the sync write-back, and still reads legacy plaintext rows. On container start, `orchestrator/src/server/db/gmail-token-encryption.ts` (wired into `db/migrate.ts`) takes a verified 0600 backup, `jobs_pre_gmail_token_encryption_<UTC timestamp>.db`, then encrypts legacy rows in one transaction. It is a no-op once no plaintext remains. A rollback script (`db/rollback-gmail-token-encryption.ts`, npm script `db:rollback-gmail-token-encryption`) and an `AGENTS.md` operator bullet document the way back.

**Approval path.** The approver (`decision.md`) escalated rather than auto-merging, because the change touches credential storage, rewrites live DB rows on start, and adds a new npm script. The owner then approved the merge directly in chat (option 1: merge now and run the migration at the next rebuild). The migration has not yet run against real data.

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 1. Connect stores ciphertext only | Met | `service.test.ts` |
| 2. Sync write-back stays encrypted; unchanged token not rewritten | Met | `gmail-sync.test.ts` |
| 3. Legacy plaintext rows still work | Met | `gmail-credentials.test.ts`, `gmail-sync.test.ts`, `service.test.ts` |
| 4. Bad key degrades safely | Met | sync reports not connected; disconnect skips revoke |
| 5. Migration encrypts, backs up, verifies | Met | `migrate.test.ts` child-process test |
| 6. Idempotent | Met | second run byte-identical, one backup |
| 7. Failure leaves data untouched | Met | backup forced to fail: exit 0, rows unchanged |
| 8. Other tenants and data survive | Met | two tenants, IMAP row, jobs count unchanged |
| 9. Rollback restores plaintext | Met | rollback test; wrong key exits non-zero, writes nothing |
| 10. No token values in logs | Met | child-run output checked for seeded tokens |
| 11. Rollback command and AGENTS.md note | Met | `orchestrator/package.json`; AGENTS.md bullet |
| 12. CI-parity checks | Met | build.md: 2417 tests passed |

## Rounds
| Round | security | ux | ui | code |
|---|---|---|---|---|
| 1 | PASS | PASS | PASS | PASS |

## Iterations
None: every reviewer passed round 1.

## Proposed guardrails
| Where | Add | Prevents |
|---|---|---|
| AGENTS.md (Webhook and LLM Payload Defaults) | "Any change that rewrites stored secrets in place must also purge old values from SQLite free pages and WAL (`PRAGMA secure_delete=ON` or `wal_checkpoint(TRUNCATE)` + `VACUUM`), or state in the spec that it does not." | Encryption at rest that leaves old plaintext readable in `jobs.db` and `jobs.db-wal` (security Note 1) |

## Follow-ups
- [ ] Security Note 1: after the migration UPDATE, old plaintext tokens can remain in free pages of `jobs.db` and in `jobs.db-wal`. Add `secure_delete` or `wal_checkpoint(TRUNCATE)` + `VACUUM` in a follow-up job.
- [ ] Older backups (`jobs_YYYY_MM_DD.db`) still hold plaintext tokens until retention removes them.
- [ ] After the rebuild, confirm the upgrade, then delete `data/jobs_pre_gmail_token_encryption_*.db` (it holds plaintext tokens).
- [ ] Keep `data/credentials-key` (or `CREDENTIALS_ENCRYPTION_KEY`) with the DB. Losing it makes Gmail read as not connected until reconnected.
- [ ] Update the self-hosting, backup and Gmail docs pages, which still describe plaintext storage.
- [ ] The key lives on the same volume as the DB, so this protects against a leaked DB or backup alone, not full volume access.
- [ ] Assumption to confirm: a failed backup or migration on startup lets the app boot with plaintext still in place.

## Mission fit
Fits: it hardens self-hosted operation in Docker and serves the "no leaked secrets" success measure while preserving the DB through the migration. Drift: none.
