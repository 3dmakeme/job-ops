VERDICT: PASS

## Findings
None.

## Notes
1. **Plaintext remnants in the live DB file (non-blocking, worth a follow-up).** `orchestrator/src/server/db/gmail-token-encryption.ts:121-131` rewrites the `credentials` JSON with an UPDATE. SQLite does not overwrite the old row contents, so the old plaintext tokens can stay readable in free pages of `jobs.db`, and for a while in `jobs.db-wal`, until those pages are reused. Anyone who copies `jobs.db` after the upgrade could still pull the tokens out of it. This doesn't block the change, because before it the tokens were stored in plaintext anyway, but encryption at rest is only partly achieved until this is fixed. Suggested follow-up: after `applyUpdates`, run `PRAGMA wal_checkpoint(TRUNCATE)` and `VACUUM`, or turn on `PRAGMA secure_delete=ON` for the migration's connection. Auto and manual backups taken before the upgrade (`jobs_YYYY_MM_DD.db` and others) also still hold plaintext tokens until retention deletes them. That could go in the AGENTS.md operator note next to the existing advice to delete the backup.
2. **The migration backup holds plaintext tokens.** It is created with `wx` and mode `0o600`, is chmodded again after `sqlite.backup`, is deleted if the backup or its check fails, and is documented in AGENTS.md as something to delete once the upgrade is confirmed. That matches the spec. SQLite may briefly create a `-journal` file next to it with umask permissions while the backup is written. That file is short-lived and only readable by local users who could already read `DATA_DIR`.
3. **The key sits next to the data.** `DATA_DIR/credentials-key` is on the same volume as `jobs.db`. So encryption protects against the DB or its backups leaking on their own, not against someone who has access to the whole volume. This was already true and the spec leaves it out of scope (no change to `credential-crypto.ts`).
4. **Logging.** Migration and rollback log only `{ rowsMigrated | rowsRolledBack, backupFile }` and `integrationId`. `decryptSecret` errors are generic strings. The disconnect warning logs `provider`, `accountKey` and `initiatedBy`, with no token values. Tests check that child stdout and stderr contain none of the seeded tokens.
5. **Public status.** `toPublicIntegration` still returns only booleans, `scope`, `tokenType`, `expiryDate` and `email`. Neither the ciphertext nor the plaintext reaches API responses.
6. **Install-wide raw sqlite access.** The migration and rollback run across all tenants on purpose (spec Req 6) and are reachable only from the container entrypoint or an operator shell, not from HTTP. Runtime reads and writes still go through the tenant-scoped repository. All SQL uses constants or bound `?` parameters.
7. **Dependencies and secrets.** No new packages. No keys, credentials or `.env` values committed. Test tokens are fake fixtures.

secure-endpoint checklist: no new or changed HTTP endpoint. The existing Gmail connect, status, disconnect and sync handlers keep their auth and tenant scoping; only how credentials are stored changed.
- Items 1-3, 5 and 8: unchanged and not affected.
- Item 4: n/a.
- Item 6: stored JSON is guarded with try/catch and a shape check before use.
- Item 7: all queries are parameterised. File paths come from `getDataDir()`, not from user input.
- Item 9: errors stay generic.
- Item 10: the migration runs as the container user that already owns `DATA_DIR`, and needs no new grants.
- Item 11: the key is read only through the `credential-crypto` loader.
- Items 12-13: n/a (no Next.js or Python, no client input).
