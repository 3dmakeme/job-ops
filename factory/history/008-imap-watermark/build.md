STATUS: READY

# Build: IMAP incremental sync watermark

## Summary
IMAP sync now keeps a per-account watermark `{ uidValidity, lastUid }` in `credentials.syncWatermark`.

- **First sync** (no valid watermark): behaves as before, using the 90-day / 100-message window, newest first.
- **Incremental sync** (watermark `uidValidity` matches the mailbox): calls the new `searchUidsAfter(lastUid)`, takes the oldest `maxMessages` UIDs in ascending order, and applies the byte budget in that order.
- **Reset** (`uidValidity` changed): logs a warning, drops the watermark and runs a full-window sync.

The watermark only advances to max(C) when every candidate was processed. Otherwise it stops at (lowest unprocessed UID − 1), where unprocessed means budget-skipped, not returned by the server, or errored. In incremental mode it never moves backwards.

It is saved through a new optional `onItemsProcessed` hook on `runPostApplicationIngestion`; Gmail does not pass the hook. The save works like this:
- It re-reads the integration and skips the save if the account was disconnected, or reconnected (different host, port, username or `passwordEncrypted`).
- The write goes through the new `replacePostApplicationIntegrationCredentialsIfUnchanged`. In one synchronous better-sqlite3 transaction, tenant-scoped, it re-reads the row and writes only if the stored credentials still deep-equal the ones read. A disconnect or reconnect that lands between the read and the write therefore makes the save skip. It can never write back removed or replaced credentials.
- The write happens only when the value changes, and every other credential key is preserved.

Each sync logs one `logger.info("IMAP sync watermark", { provider, accountKey, mode, candidateCount, previousLastUid, newLastUid, watermarkWrite })`. `watermarkWrite` is `stored`, `unchanged` or `skipped`. When the save is skipped, `newLastUid` is null.

Files changed (vs merge-base with main):
- `orchestrator/src/server/services/post-application/ingestion/imap-client.ts`: `searchUidsAfter`
- `orchestrator/src/server/services/post-application/ingestion/imap-sync.ts`: mode selection, watermark parse, resolve and persist
- `orchestrator/src/server/services/post-application/ingestion/message-ingest.ts`: `onItemsProcessed` hook
- `orchestrator/src/server/repositories/post-application-integrations.ts`: new `replacePostApplicationIntegrationCredentialsIfUnchanged`. `updatePostApplicationIntegrationSyncState` is unchanged, so its Gmail callers are unaffected.
- Tests: `imap-sync.test.ts`, `imap-client.test.ts`, `providers/imap.test.ts`
- `AGENTS.md`: watermark bullet

## Acceptance criteria
1. [x] imap-sync.test.ts passes with cases (a) to (i). The file passes as part of the post-application run (120 tests).
   - (a) First sync: 90-day window, newest 100 of 150, stores `{777, 150}`. An empty first sync stores nothing.
   - (b) Incremental: calls `searchUidsAfter(20)` and not `searchUidsSince`, uses `[21,22,23]`, stores 23, and logs the info fields.
   - (c) Reset: logs the warning, uses the full window and stores `{777, 12}`. An empty reset removes the key.
   - (d) Budget-skipped UID 83 holds the watermark at 82.
   - (e) A parse error at UID 11, or UID 11 missing from the sources, holds it at 10.
   - (f) An empty incremental search writes nothing.
   - (g) Seven malformed shapes are each treated as a first sync.
   - (h) Other credential keys and their order are kept.
   - (i) The read-only guard runs across the first, incremental and reset modes, and also checks `expunge`.

   Round-2 additions:
   - A reconnect with a new password skips the save.
   - When the conditional write reports a change, the log says `watermarkWrite: "skipped"` with `newLastUid: null` and contains no credentials.
   - The reconnect and disconnect tests assert the skipped log.
   - The save uses `expectedCredentials` equal to the credentials read, and never sends credentials through `updatePostApplicationIntegrationSyncState`.
2. [x] imap-client.test.ts: `searchUidsAfter(10)` calls `search({ uid: "11:*" }, { uid: true })` and turns `[9,10,11,14]` into `[11,14]`. Passes.
3. [x] providers/imap.test.ts (real SQLite) passes, 27 tests. It covers:
   - the watermark is stored but not exposed by status (the status keys are exactly host/port/tls/username/hasPassword);
   - a reconnect resets the watermark;
   - the cross-tenant watermark test;
   - round 2: the race tests below.
4. [x] The Gmail tests pass, and `git diff main -- gmail-sync.ts gmail-api.ts` is empty (0 lines).
5. [x] `git diff main...HEAD --stat` (the branch's own changes) lists only the 8 files above, with nothing under `orchestrator/src/server/db/`, `docs/` or `docs-site/`. The two-dot `git diff main` now also shows commits that landed on main after the branch point; those are not from this branch.
6. [x] `grep -n "syncWatermark" AGENTS.md` finds the bullet at line 70.
7. [x] `grep -nE "messageFlags|messageDelete|messageMove|expunge"` over imap-client.ts and imap-sync.ts finds no matches.
8. [x] All seven CI-parity checks pass (see Validation).

## Validation
Round 2, run from the worktree root after the fix:
- `./orchestrator/node_modules/.bin/biome ci .`: passed (1112 files)
- `npm run check:types:shared`: passed
- `npm --workspace orchestrator run check:types`: passed
- `npm --workspace gradcracker-extractor run check:types`: passed
- `npm --workspace ukvisajobs-extractor run check:types`: passed
- `npm --workspace orchestrator run build:client`: passed
- `npm --workspace orchestrator run test:run`: passed (322 files, 2451 passed, 2 skipped)

No UI changes, so no browser check was needed.

## Log
### Round 1
- Implemented `searchUidsAfter`, the `onItemsProcessed` hook, watermark mode selection, advancement and persistence, plus tests and the AGENTS.md bullet.
- Design notes:
  - A first sync with no candidates writes nothing.
  - The reset warning is "IMAP UIDVALIDITY changed; discarding sync watermark".
- Declined: the spec's follow-up docs-site edits, because docs are kept outside the factory.
- Commits: `5407bfd`, `7287251`.

### Round 2 (rework-1)
- **Race between the watermark read and write** (decision.md, security note): fixed.
  - Added `replacePostApplicationIntegrationCredentialsIfUnchanged` to the repository. It runs a synchronous `db.transaction` that re-selects the row with `integrationsScopeFilter()`, compares the stored credentials to the expected ones with `isDeepStrictEqual`, and updates only on a match (the update is also scoped by tenant filter and id). It returns whether it wrote.
  - `persistImapSyncWatermark` now uses it, and also treats a changed `passwordEncrypted` as a reconnect.
  - `updatePostApplicationIntegrationSyncState` is unchanged, so the Gmail callers behave exactly as before.
- **Tests requested by the rework**, in `providers/imap.test.ts` against the real DB: the repository module is mocked with lazy pass-throughs to the real module, so a test can run an action between the save's read and its conditional write.
  1. "does not restore credentials removed by a disconnect during the watermark save": credentials stay null.
  2. "keeps a new password set by a reconnect during the watermark save": the stored password decrypts to the new password, and there is no `syncWatermark`.
  3. "saves the watermark when nothing changes during the save": the hook ran and the credentials equal the earlier credentials plus `syncWatermark`.

  Mutation check: with the compare removed, tests 1 and 2 fail.
- **Reviewer note about the log showing an unsaved `newLastUid`**: fixed. The log is now written after the save, with `watermarkWrite: "stored" | "unchanged" | "skipped"` and `newLastUid: null` when skipped. It contains no credentials. It is still one info line per sync.
- Re-ran all seven CI-parity checks: all pass.
- Commit: `0e5f952 fix: save IMAP watermark with compare-and-set so it never restores credentials`.
