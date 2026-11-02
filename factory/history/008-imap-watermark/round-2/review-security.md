VERDICT: PASS

## Findings
None.

## Notes
- **Round-1 note (credentials race): fixed.**
  - `persistImapSyncWatermark` (`imap-sync.ts`) now skips the save if host, port, username or `passwordEncrypted` changed since the sync connected. It then writes through the new `replacePostApplicationIntegrationCredentialsIfUnchanged` (`repositories/post-application-integrations.ts:211-249`).
  - That function runs one synchronous better-sqlite3 `db.transaction`. Inside it, it re-reads the row with the tenant scope filter, deep-compares the stored credentials with the ones the caller read, and writes only if they are still equal. The update is also scoped by `scopeFilter` and the row id.
  - So a disconnect (credentials null, which fails the compare) or a reconnect with a new password between the read and the write gives `false`, and the old or removed credentials are never written back.
  - The real-DB tests in `providers/imap.test.ts` cover a disconnect during the save, a reconnect during the save and the normal path. They pass locally, together with `imap-sync.test.ts`: 66 tests.
- **Gmail path untouched.** `updatePostApplicationIntegrationSyncState` is unchanged, and the IMAP sync no longer sends credentials through it.
- **Logging.** When the save is skipped, the log has `watermarkWrite: "skipped"` and `newLastUid: null`. The log has no credentials and no message content.
- **Access control / tenancy.** No new endpoint or action. Every read and write goes through `integrationsScopeFilter()`. The cross-tenant watermark test is still there.
- **Data exposure.** `toPublicIntegration` still whitelists only `host`, `port`, `tls`, `username` and `hasPassword`. `syncWatermark` is never returned.
- **Input.** Only the server writes the watermark. `parseImapSyncWatermark` validates it. The `${lastUid + 1}:*` range comes from a validated non-negative integer and goes into an imapflow search object.
- **Read-only mailbox.** No flag, move, delete or expunge calls.
- **Dependencies / secrets.** No new packages (`node:util` is built in), and no secrets in the diff.
- **secure-endpoint checklist.** No concerns. Checked items 1-13.
  - Items 1, 2, 3 and 8: no new endpoint, and the existing `sync` action and tenant scoping are unchanged.
  - Item 4: n/a.
  - Item 5: n/a, there are no audit fields.
  - Item 6: the stored watermark is validated.
  - Item 7: only the Drizzle query builder is used, with no raw SQL or shell.
  - Item 9: errors still map through `toImapError` and the existing failure path.
  - Item 10: no new grants.
  - Item 11: nothing committed or logged.
  - Items 12 and 13: n/a, there is no Next.js and no Python.
