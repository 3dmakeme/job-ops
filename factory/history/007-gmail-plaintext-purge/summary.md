# Purge leftover plaintext Gmail tokens from jobs.db after encryption
Outcome: merged 2026-11-02 after 1 review round (0 reworks) · Mission fit: Fits

> Feature: Purge old plaintext Gmail tokens from SQLite after the encryption migration: after gmail-token-encryption.ts updates rows, remove leftover plaintext from jobs.db free pages and the WAL (for example PRAGMA wal_checkpoint(TRUNCATE) plus VACUUM, or secure_delete for that connection), only after the verified backup exists and the update has committed; idempotent, no-op when nothing was migrated, tests that the old token string is no longer present in the database file bytes, and an AGENTS.md operator note that older jobs_*.db backups still hold plaintext until retention removes them

Approval: all four reviewers passed in round 1. The approver (`decision.md`) escalated to the owner because the change touches credential security and rewrites the live `jobs.db` on container start. The owner then approved the merge directly in chat ("carry on with the backlog and merge 007").

## What shipped
After the 006 migration encrypted Gmail tokens, SQLite still held the old plaintext in free pages and WAL frames. `encryptLegacyGmailTokens` now runs `purgeFreedPlaintext` after the backup is verified and the update has committed. It runs `wal_checkpoint(TRUNCATE)`, `VACUUM`, then `wal_checkpoint(TRUNCATE)` on the same connection. An incomplete checkpoint or a thrown error is only logged as a warning, and startup carries on. Changes are in `orchestrator/src/server/db/gmail-token-encryption.ts`, `orchestrator/src/server/db/migrate.test.ts` (byte-level test, WAL seed, stricter no-op test) and a new `AGENTS.md` bullet (line 69) about the VACUUM and the plaintext left in older backups.

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 1. Live `jobs.db` / WAL bytes hold no seeded tokens | Met | new byte-level test; migrate.test.ts 15/15 |
| 2. Byte test fails without the purge | Met | build.md: call commented out, assertion failed. Approver did not re-check |
| 3. Backup still holds plaintext, passes integrity_check | Met | new and existing migrate tests |
| 4. Repeat and fresh runs are no-ops | Met | extended no-op test |
| 5. Code order | Met | purge follows the update and both early returns |
| 6. Failed purge is only logged | Met | own try/catch; forced busy checkpoint logged a warning and exited 0 |
| 7. Rollback unchanged | Met | empty diff on the rollback file |
| 8. AGENTS.md operator note | Met | line 69 |
| 9. Seven CI-parity checks | Met | build.md: 2418 passed, 2 skipped |

## Rounds
| Round | security | ux | ui | code |
|---|---|---|---|---|
| 1 | PASS | PASS | PASS | PASS |

## Iterations
None: every reviewer passed round 1.

## Proposed guardrails
| Where | Add | Prevents |
|---|---|---|

## Follow-ups
- [ ] Already-migrated installs keep their plaintext. The purge runs only in a run that migrates rows, so if 006 already ran on a real `jobs.db`, run `VACUUM` by hand (after a WAL checkpoint) or queue a one-off purge job.
- [ ] Delete the `jobs_pre_gmail_token_*` and `jobs_manual_*.db` backups, and old `jobs_YYYY_MM_DD.db` ones, once no longer needed. Only the automatic ones age out.
- [ ] The docs-site Gmail or self-hosting page may need a line about the post-migration VACUUM and plaintext in older backups.
- [ ] VACUUM needs temporary free disk about the size of the DB at startup; confirm for your volume.
- [ ] Freed blocks below SQLite (filesystem, snapshots) are not covered.

## Mission fit
Fits: serves "no leaked secrets" and "Self-hosting and operating the app in Docker", and keeps the SQLite data intact. Drift: none.
