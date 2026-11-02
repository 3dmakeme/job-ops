# IMAP incremental sync watermark

> Feature: IMAP incremental sync watermark: per IMAP account, store the last-seen UID together with the mailbox uidValidity (for example in the integration sync state), and on later syncs search and fetch only UIDs greater than the watermark. The first sync keeps the existing 90-day / 100-message window. If uidValidity changes, discard the watermark and fall back to the full window. Only advance the watermark past messages that were actually fetched and processed (never past messages skipped by the size budget or that errored), so nothing is silently lost. Keep the Message-ID dedupe as a safety net. Read-only on the mailbox, tenant-scoped, with tests for first sync, incremental sync, uidValidity reset, skipped/errored messages, and no change to Gmail behaviour.

## Context

All paths are under `orchestrator/src/server/`.

- **IMAP client.** `services/post-application/ingestion/imap-client.ts` wraps `imapflow`. The `ImapClient` interface has `connect`, `openInboxReadOnly` (returns `{ uidValidity: string }` and opens INBOX with `readOnly: true`), `searchUidsSince(since)`, `fetchMessageSizes(uids)`, `fetchMessageSources(uids, maxBytes)` (uses `BODY.PEEK`, so `\Seen` is never set, and drops any message the server returns without a source) and `close`. The constants `IMAP_MAX_MESSAGE_BYTES` (1 MiB) and `IMAP_MAX_SYNC_BYTES` (32 MiB) are defined here.
- **IMAP sync.** `services/post-application/ingestion/imap-sync.ts`:
  - `runImapIngestionSync({ accountKey, maxMessages?, searchDays? })` loads the integration with `getPostApplicationIntegration("imap", accountKey)`, parses the stored credentials with `parseStoredImapCredentials`, decrypts the password and calls `runPostApplicationIngestion`.
  - `fetchRecentInboxMessages` runs on every sync. It searches `SINCE now - searchDays` (default 90), sorts the UIDs newest first, keeps `maxMessages` of them (default 100), fetches their sizes, and fits them into the byte budget with `selectUidsWithinBudget`. That function goes through the UIDs in order, skips any UID that doesn't fit and logs `"IMAP sync byte budget exceeded; skipping messages"`. It then fetches the sources of the selected UIDs.
  - Each item's list-level `externalMessageId` is `uid:<uidValidity>:<uid>`. `mapParsedImapMessage` sets the stored `externalMessageId` to the Message-ID header, falling back to `uid:<uidValidity>:<uid>`.
  - No watermark exists today. Every sync re-reads the whole window.
- **Shared ingestion.** `services/post-application/ingestion/message-ingest.ts` holds `runPostApplicationIngestion({ provider, accountKey, integrationId, failureErrorCode, listItems })`, which Gmail and IMAP share.
  - It calls `listItems()` and then processes every item with `runWithConcurrency`.
  - A per-item error (in `load`, classification or upsert) increments `errored` and logs `item.externalMessageId`.
  - Dedupe: when `getPostApplicationMessageByExternalId` finds an existing row, the message is re-upserted with its existing classification and is not re-classified. This is the Message-ID safety net.
  - When the run ends, it calls `completePostApplicationSyncRun` and `updatePostApplicationIntegrationSyncState` (`lastSyncedAt`, `lastError`, `status`). If `listItems` throws, the whole run fails.
- **Gmail.** `services/post-application/ingestion/gmail-sync.ts` also calls `runPostApplicationIngestion`. It must not change behaviour.
- **Integration storage.** `repositories/post-application-integrations.ts`.
  - Every read and write is scoped by `privateDataScopeFilter` (tenant and user).
  - `updatePostApplicationIntegrationSyncState` accepts an optional `credentials` object and replaces the whole JSON value.
  - `upsertConnectedPostApplicationIntegration` (connect or reconnect) replaces `credentials` wholesale.
  - `disconnectPostApplicationIntegration` sets `credentials` to null.
  - Table: `post_application_integrations` in `db/schema.ts`, with columns `credentials` (JSON), `last_synced_at` and `last_error`. It has no sync-state column. `rebuildPostApplicationPrivateTables()` in `db/migrate.ts` runs on every start-up and copies an explicit column list into a rebuilt table.
- **Public view.** `services/post-application/providers/imap.ts`. `toPublicIntegration` whitelists `host`, `port`, `tls`, `username` and `hasPassword` from the stored credentials, so other keys are never returned by the API. The `sync` action passes `payload.maxMessages` and `payload.searchDays` through to `runImapIngestionSync`.
- **Tests.**
  - `services/post-application/ingestion/imap-sync.test.ts` mocks the IMAP client and the repositories, and includes a read-only guard that fails if any flag, move or delete method is called.
  - `services/post-application/providers/imap.test.ts` runs against a real temp SQLite database, including the cross-tenant test "does not expose an integration to another tenant" (uses `runWithRequestContext`).
  - `services/post-application/ingestion/imap-client.test.ts` covers the client.
  - Gmail is covered by `gmail-sync.test.ts` and `gmail-sync.idempotency.test.ts`.
- `AGENTS.md` describes the IMAP size limits under "Webhook and LLM Payload Defaults".

## Requirements

1. **Watermark storage.** The watermark for each IMAP account is stored in that integration's `credentials` JSON under the key `syncWatermark`, as `{ uidValidity: string, lastUid: number }`.
   - `lastUid` is a non-negative integer.
   - Add no new table or column.
   - Reading and writing go through the existing tenant-scoped functions in `repositories/post-application-integrations.ts`.
   - A missing or malformed `syncWatermark` (wrong types, or a negative or non-integer `lastUid`) is treated as no watermark.
   - `parseStoredImapCredentials` and `toPublicIntegration` keep ignoring the key: it is never returned by the API.
2. **Incremental search.** Add `searchUidsAfter(lastUid: number): Promise<number[]>` to the `ImapClient` interface and to `createImapClient`.
   - It runs a UID search for the range `${lastUid + 1}:*` and returns only UIDs strictly greater than `lastUid`. The filter is needed because IMAP resolves `*` to the highest existing UID, which can be at or below `lastUid`.
   - Failures map through `toImapError` like the other methods.
   - It must not open the mailbox read-write or set any flags.
3. **Choosing the mode.** After `openInboxReadOnly()`, a sync compares the stored watermark with the mailbox `uidValidity`.
   - **First sync**, when there is no valid watermark: behave exactly as today. Search `SINCE now - searchDays`, take the newest `maxMessages` UIDs, apply the byte budget newest first.
   - **Reset**, when a watermark exists but its `uidValidity` differs from the mailbox's: discard the watermark, log a `logger.warn` with `provider`, `accountKey`, the old and new `uidValidity`, then behave exactly as a first sync.
   - **Incremental**, when the watermark matches: call `searchUidsAfter(lastUid)`, sort the UIDs ascending and take the oldest `maxMessages` of them, apply the byte budget in that ascending order, then fetch. `searchDays` is not used in this mode, and `searchUidsSince` is not called.
4. **Advancing the watermark.** Let *C* be the candidate UIDs this run: the UIDs left after the `maxMessages` cap and before the byte budget. A UID in *C* counts as processed only if:
   - it was selected within the budget, and
   - its source was returned by `fetchMessageSources`, and
   - its ingestion item finished without error.

   The new value of `lastUid` is set as follows:
   - If every UID in *C* was processed, `lastUid` = max(*C*).
   - Otherwise, `lastUid` = (the smallest unprocessed UID in *C*) − 1.

   In incremental mode the watermark must never move backwards: if this formula gives a value below the stored `lastUid`, keep the stored value. If *C* is empty, the stored watermark stays unchanged in incremental mode. In first-sync mode nothing is stored. In reset mode the old watermark is removed and nothing new is stored.
5. **Per-item outcome hook.** Give `runPostApplicationIngestion` an optional argument `onItemsProcessed?: (outcome: { erroredExternalMessageIds: ReadonlySet<string> }) => Promise<void>`.
   - The set holds the list-level `externalMessageId` of every item that errored.
   - The hook is called once, after all items are processed and before `completePostApplicationSyncRun`. It is not called if `listItems` throws.
   - If the hook throws, the run fails through the existing failure path.
   - Gmail does not pass the hook, and Gmail's behaviour, calls and stored data do not change.
6. **Persisting the watermark.** The IMAP sync persists the new watermark inside `onItemsProcessed`:
   - Re-read the integration with `getPostApplicationIntegration("imap", accountKey)`.
   - If the stored `host`, `port` and `username` no longer match the ones this sync connected with (the account was reconnected during the sync) or the credentials are gone, skip the write.
   - Otherwise write `{ ...currentCredentials, syncWatermark }` through `updatePostApplicationIntegrationSyncState({ provider: "imap", accountKey, credentials })`. When the watermark is being discarded, write the credentials without `syncWatermark`.
   - Write only when the stored value changes. Every other credentials key (including `passwordEncrypted`) must be kept byte for byte.
7. **Dedupe kept.** The existing dedupe by `externalMessageId` (Message-ID, or the `uid:` fallback) in `runPostApplicationIngestion` stays as it is, so a message fetched again after the watermark was held back is not re-classified.
8. **Read-only.** The sync never calls any flag, move, delete or expunge method, and INBOX is still opened with `readOnly: true`.
9. **Logging.** Each IMAP sync logs one `logger.info` with `provider`, `accountKey`, `mode` (`first`, `incremental` or `reset`), `candidateCount`, `previousLastUid` and `newLastUid` (null when absent). Use the shared logger. Log no message content and no credentials.
10. **Tests.**
    - In `imap-sync.test.ts`, add tests for:
      - (a) first sync uses `searchUidsSince` with the 90-day / 100-message window and stores `{ uidValidity, lastUid: max }`;
      - (b) incremental sync calls `searchUidsAfter(lastUid)`, does not call `searchUidsSince`, takes the oldest `maxMessages` UIDs in ascending order, and advances the watermark;
      - (c) a `uidValidity` mismatch discards the watermark, uses the full window, logs the reset warning and stores the new `uidValidity`;
      - (d) a UID skipped by the byte budget holds the watermark at (that UID − 1);
      - (e) a UID whose item errors (for example a parse failure) holds the watermark at (that UID − 1), and a UID missing from `fetchMessageSources` does the same;
      - (f) an incremental search that returns nothing leaves the watermark unchanged and writes nothing;
      - (g) a malformed `syncWatermark` is treated as a first sync;
      - (h) other credential keys are preserved when the watermark is written;
      - (i) the existing read-only guard test also covers the incremental path.
    - In `imap-client.test.ts`, add a test that `searchUidsAfter` searches the `lastUid+1:*` UID range and filters out UIDs ≤ `lastUid`.
    - In `providers/imap.test.ts` (real DB), add:
      - a test that after a sync the stored credentials contain `syncWatermark` while the `status` response still exposes only `host`, `port`, `tls`, `username` and `hasPassword`;
      - a cross-tenant test that a watermark stored for tenant A's `default` account is not read or changed by a sync run under another tenant.
    - The existing Gmail tests must pass unchanged.
11. **AGENTS.md.** Add a bullet after the IMAP size-limit bullet. It must say:
    - IMAP sync stores a per-account watermark `{ uidValidity, lastUid }` under `credentials.syncWatermark`;
    - later syncs fetch only UIDs above it;
    - a `uidValidity` change, a reconnect or a disconnect resets it to the 90-day / 100-message window;
    - it never advances past budget-skipped, unfetched or errored messages.

## Acceptance criteria

1. `npm --workspace orchestrator run test:run -- src/server/services/post-application/ingestion/imap-sync.test.ts` passes and includes passing tests for cases (a) to (i) in Requirement 10.
2. `npm --workspace orchestrator run test:run -- src/server/services/post-application/ingestion/imap-client.test.ts` passes and includes a test showing that `searchUidsAfter(10)` issues a UID search for `11:*` and drops a returned UID of 10 or lower.
3. `npm --workspace orchestrator run test:run -- src/server/services/post-application/providers/imap.test.ts` passes. It includes a test that after a sync the DB row's `credentials.syncWatermark` matches `{ uidValidity, lastUid }`, while the `status` action's `integration.credentials` keys are exactly `host`, `port`, `tls`, `username` and `hasPassword`. It also includes a cross-tenant watermark test.
4. `npm --workspace orchestrator run test:run -- src/server/services/post-application/ingestion/gmail-sync.test.ts src/server/services/post-application/ingestion/gmail-sync.idempotency.test.ts` passes, and `git diff main -- orchestrator/src/server/services/post-application/ingestion/gmail-sync.ts orchestrator/src/server/services/post-application/ingestion/gmail-api.ts` is empty.
5. `git diff main --stat` shows no change under `orchestrator/src/server/db/` (no schema or migration change) and none under `docs/` or `docs-site/`.
6. `grep -n "syncWatermark" AGENTS.md` finds the new bullet described in Requirement 11.
7. `grep -nE "messageFlags|messageDelete|messageMove|expunge" orchestrator/src/server/services/post-application/ingestion/imap-client.ts orchestrator/src/server/services/post-application/ingestion/imap-sync.ts` finds no matches.
8. All CI-parity checks from AGENTS.md pass from the repo root: `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace gradcracker-extractor run check:types`, `npm --workspace ukvisajobs-extractor run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.

## Out of scope

- Any database schema change, new column or table, or edit to `db/migrate.ts`.
- Any change to Gmail sync (for example a Gmail history-ID watermark).
- UI changes. The watermark is not shown, and there is no "reset watermark" button or API action. Reconnecting the account resets it.
- Watching folders other than INBOX, using IDLE or CONDSTORE/QRESYNC, or making the window or budget constants configurable.
- Back-filling messages older than the first-sync window, or changing the 90-day / 100-message defaults.
- Changing the per-message or per-sync byte limits, or how messages are mapped or classified.
- Follow-up, not for this job: `docs-site/docs/features/post-application-tracking.md` ("Max Messages and Search Days apply to IMAP…" and the "IMAP sync limits" section) and `docs-site/docs/workflows/post-application-workflow.md` ("Configure IMAP sync") will need a note that Search Days applies only to the first sync and after a reset, and that later syncs fetch only new messages. Docs are kept separately.

## Assumptions

- **Storage in `credentials.syncWatermark`, not a new column.** The table has no sync-state column, and `rebuildPostApplicationPrivateTables()` rebuilds the table on every start-up from a fixed column list, so a new column would need migration work that risks the existing data. The credentials JSON is already written by the sync-state helper and is whitelisted out of API responses.
- **Reconnect and disconnect reset the watermark.** Both replace or null `credentials`. The next sync is then a safe first sync, and dedupe prevents re-classification.
- **Incremental mode takes the oldest `maxMessages` UIDs above the watermark (ascending).** Taking the newest would leave an older backlog that the "never skip" rule could never get past. Ascending order lets a backlog drain over several syncs.
- **Incremental mode ignores `searchDays`.** The request says to fetch only UIDs above the watermark. Adding a date filter could silently drop messages with old internal dates.
- **The first sync stores `max(C)` (or the smallest unprocessed UID − 1).** Messages older than the newest 100 in the 90-day window are not ingested, as today.
- **An empty first sync stores no watermark.** Storing `lastUid: 0` would make the next sync read the whole mailbox from UID 1, which would pull in years of old mail.
- **A failure to persist the watermark fails the run.** This matches the existing rule that non-item errors fail the run, and makes the problem visible. Already-ingested messages are protected by dedupe.
- **Concurrent syncs of the same account may move the watermark backwards but never past unprocessed mail.** A backwards move only causes a re-read, which dedupe absorbs. No lock is added.
- **The reconnect check compares `host`, `port` and `username`.** This stops a watermark from one mailbox being attached to another account's credentials if a reconnect happens mid-sync.

## Mission fit
Fits: makes "Tracking applications, interviews and post-application email" from the user's own IMAP mailbox cheaper and safer, with no lost messages ("No lost or mis-routed applications"), inside the multi-tenant constraint.
