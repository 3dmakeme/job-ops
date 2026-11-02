ESCALATE

## Why
The work itself is sound. All 9 acceptance criteria are met, all four reviewers (security, ux, ui, code) PASS in round 1, `git merge-tree` reports no conflicts, and I re-ran the focused migrate tests myself (15/15 pass). It still needs a human because it touches credential security (OAuth Gmail token storage) and it rewrites the live production `jobs.db` on container start: a WAL checkpoint plus `VACUUM` after migrating rows. AGENTS.md has nothing that relaxes these rules, and 006, the sibling job, was escalated for the same reasons.

## Acceptance criteria
1. Live DB/WAL bytes hold no seeded tokens: met. The new byte-level test is in the diff, and I re-ran `test:run -- src/server/db/migrate.test.ts` myself: 15/15 passed.
2. The byte test fails without the purge: met according to build.md, which reports an `AssertionError: expected true to be false` with the call commented out. I did not re-check this.
3. The backup still holds plaintext and passes integrity_check: met. The new test asserts the backup bytes contain every token, and the existing test still checks integrity and mode 0600.
4. Repeat and fresh runs are no-ops: met. The extended test checks the rows, the job count, the directory listing, the backup count and the absence of the purge log.
5. Code order: met. I read the diff: the purge comes after `applyUpdates` and the encrypted log, and both early returns come before it.
6. A failed purge is only logged: met. It has its own try/catch, and `logger.warn` carries only the summary, the checkpoint counts and the error (sanitized by `@infra/logger`). `expectNoTokens` still passes.
7. Rollback unchanged: met. The diff of `rollback-gmail-token-encryption.ts` against main is empty.
8. AGENTS.md note: met. A new bullet straight after the Gmail token bullet mentions VACUUM, `jobs_manual_*.db`, `jobs_pre_gmail_token_*` and retention.
9. CI-parity checks: met according to build.md Validation (2418 passed). The code reviewer re-ran biome, the types check and the focused tests.

## For the human
Decide whether to let this run on your real data: on the next container start that migrates legacy Gmail rows, startup runs `wal_checkpoint(TRUNCATE)`, then `VACUUM`, then `wal_checkpoint(TRUNCATE)` on `DATA_DIR/jobs.db`. This needs temporary free disk space about the size of the DB. If it fails, it only logs a warning.
- Code: `orchestrator/src/server/db/gmail-token-encryption.ts` (`purgeFreedPlaintext`, `checkpointTruncate`, and the try/catch at the end of `encryptLegacyGmailTokens`).
- Tests: `orchestrator/src/server/db/migrate.test.ts`.
- Operator note: `AGENTS.md`, line 69 (not under `docs/`; the spec required it).
- Known gap (out of scope by the spec): installs that already migrated under 006 keep their leftover plaintext bytes, because the purge only runs in a run that migrates rows. If 006 has already run on your data, run `VACUUM` by hand, or queue a follow-up one-off purge. Also delete the `jobs_pre_gmail_token_*` and `jobs_manual_*.db` backups once you no longer need them.
- Follow-up: docs-site Gmail/self-hosting pages may need a line about the post-migration VACUUM and the plaintext left in older backups.
