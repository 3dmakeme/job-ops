STATUS: READY

# Build: IMAP sync: per-message and per-sync size caps

## Summary
IMAP sync now limits memory per message and per sync run. `imap-client.ts` exports `IMAP_MAX_MESSAGE_BYTES` (1 MiB) and `IMAP_MAX_SYNC_BYTES` (32 MiB). It adds `ImapClient.fetchMessageSizes(uids)`, which fetches `RFC822.SIZE` and returns `size: null` when the server sends none. `fetchMessageSources(uids, maxBytes)` now does a partial `BODY.PEEK[]<0.maxBytes>` fetch (`source: { maxLength }`). As a safeguard, any returned buffer longer than the limit is cut to the limit. It is copied rather than viewed, so the over-long buffer can be freed.

`fetchRecentInboxMessages` in `imap-sync.ts` fetches sizes for the newest `maxMessages` UIDs. It then fills the 32 MiB budget greedily from newest to oldest: each message is charged `min(size, 1 MiB)`, and a message with no size is charged the full 1 MiB. Messages that don't fit are skipped, and older, smaller ones can still fit after a skip. Sources are fetched only for the selected UIDs, capped at 1 MiB each. It logs one structured `logger.warn` per truncated message (`provider, accountKey, uid, sizeBytes, limitBytes`). It also logs one warning per sync when any messages were skipped (`provider, accountKey, skippedCount, skippedUids, budgetBytes`). Skipped messages never reach `runPostApplicationIngestion`. The summary, API and shared types are unchanged.

Files changed:
- `orchestrator/src/server/services/post-application/ingestion/imap-client.ts`
- `orchestrator/src/server/services/post-application/ingestion/imap-sync.ts`
- `orchestrator/src/server/services/post-application/ingestion/imap-client.test.ts`
- `orchestrator/src/server/services/post-application/ingestion/imap-sync.test.ts`
- `AGENTS.md` (one line under "Webhook and LLM Payload Defaults", as Requirement 9 asks; this is not under `docs/`)

## Acceptance criteria
1. [x] Constants exported and used in imap-sync.ts: the grep shows `imap-client.ts:6 export const IMAP_MAX_MESSAGE_BYTES = 1 * 1024 * 1024;` and `imap-client.ts:8 export const IMAP_MAX_SYNC_BYTES = 32 * 1024 * 1024;`, plus uses in `imap-sync.ts` (import, budget walk, warnings, source fetch limit).
2. [x] `grep -n "source: true" imap-client.ts` prints nothing (exit 1). `grep -n maxLength` finds `153: { uid: true, source: { maxLength: maxBytes } }`.
3. [x] `npm --workspace orchestrator run test:run -- imap-client`: 12 passed. The new tests cover the `fetchMessageSizes` query `{ uid: true, size: true }` with `{ uid: true }`, a missing size mapping to `null`, empty input making no server call, and error mapping through `toImapError`. They also check that `fetchMessageSources` sends `source: { maxLength: 4 }` and that a 10-byte returned buffer comes back with exactly 4 bytes, and that both constants have the right values. The existing source-fetch assertion was updated to `source: { maxLength: 1024 }`.
4. [x] `npm --workspace orchestrator run test:run -- imap-sync`: 14 passed. New tests:
   - "truncates and still ingests a message over the per-message cap": a 5 MiB UID 12 is fetched and upserted, with exactly one `warn` carrying `uid`, `sizeBytes` and `limitBytes`.
   - "skips messages beyond the sync budget and fits smaller older ones": UIDs 68 (1 MiB) and 66 (null) are left out of the `fetchMessageSources` args, the older 100-byte UID 67 is fetched, `discovered` is 2, and one `warn` carries `skippedCount: 2` and `skippedUids: [68, 66]`.
   - "charges a message with no reported size at the per-message cap": 32 null-size messages use the whole budget, so a 1-byte UID is skipped.
   - "logs no size warnings when every message is small": `warn` is not called at all.
   - The existing `fetchMessageSources([12, 11])` assertion was updated to `([12, 11], IMAP_MAX_MESSAGE_BYTES)`, and a `fetchMessageSizes` assertion was added.
5. [x] Warnings are asserted with `toHaveBeenCalledWith(<message>, expect.objectContaining({...}))`. The tests also check that the field keys are exactly the Requirement 6 set (no subject, body or address).
6. [x] `AGENTS.md` line 68 names `IMAP_MAX_MESSAGE_BYTES`, `IMAP_MAX_SYNC_BYTES` and `imap-client.ts`.
7. [x] CI-parity checks: see Validation. All pass, with one caveat about locale.

## Validation
Run from the worktree root on Node v22.23.4:
- `./orchestrator/node_modules/.bin/biome ci .`: pass (1108 files, no fixes)
- `npm run check:types:shared`: pass
- `npm --workspace orchestrator run check:types`: pass
- `npm --workspace gradcracker-extractor run check:types`: pass
- `npm --workspace ukvisajobs-extractor run check:types`: pass
- `npm --workspace orchestrator run build:client`: pass
- `npm --workspace orchestrator run test:run`: under the machine's default en_GB locale, 1 test fails: `WatchlistPage.test.tsx > shows new rows by default with ignore actions`. It expects "May 1, 2026" but the page renders "1 May 2026". This is the pre-existing locale problem already queued in `factory/backlog.md`, and this change doesn't touch it. With `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`, the full suite passes: 321 files, 2398 passed, 2 skipped.

There is no UI change, so no browser check was needed.

## Log
### Round 1
- Added both constants to `imap-client.ts`, plus `fetchMessageSizes` and the partial `fetchMessageSources(uids, maxBytes)` with an over-long-buffer safeguard.
- Added the newest-first greedy budget selection and the structured truncation and skip warnings to `imap-sync.ts`. `accountKey` is now passed into `fetchRecentInboxMessages`.
- Added and updated tests in `imap-client.test.ts` and `imap-sync.test.ts`. Added the AGENTS.md line from Requirement 9.
- Commits: `413e347 feat: cap IMAP message and per-sync fetch sizes`, `138e0b5 docs: note IMAP size caps in AGENTS.md`.
