# IMAP sync: per-message and per-sync size caps

> Feature: IMAP sync: cap the size of each fetched message and the total memory used per sync (skip or truncate oversized messages, log a warning), with tests

## Context
- `orchestrator/src/server/services/post-application/ingestion/imap-client.ts` wraps `imapflow`. `ImapClient.fetchMessageSources(uids)` calls `client.fetchAll(uids, { uid: true, source: true }, { uid: true })`, which pulls the full RFC822 source of every UID into memory (`ImapFetchedMessage = { uid, source: Buffer }`). There is no size limit.
- `orchestrator/src/server/services/post-application/ingestion/imap-sync.ts`: `fetchRecentInboxMessages` connects, opens INBOX read-only, searches UIDs since `searchDays`, keeps the newest `maxMessages` UIDs (default 100; the route allows up to 500), and fetches all their sources in one call. `runImapIngestionSync` hands each one to `runPostApplicationIngestion` (`message-ingest.ts`) as an `IngestItem` whose `load()` runs `simpleParser(message.source, PARSER_OPTIONS)`.
- The security reviews in `factory/history/001-imap-email-provider/` (round-1 and round-2 `review-security.md`, plus the follow-up in `summary.md`) flagged this as a memory risk. They suggested requesting `size` in the fetch query and limiting large messages.
- `imapflow` (^2.10.0) supports both mechanisms this needs. `FetchQueryObject.size: true` returns `RFC822.SIZE` as `message.size`. `source: { maxLength }` does a partial fetch (`BODY.PEEK[]<0.maxLength>`), so the server sends at most `maxLength` bytes. See `node_modules/imapflow/dist/esm/types.d.ts`.
- Logging goes through `logger` from `@infra/logger` as structured objects (AGENTS.md "Logging Rules"). `imap-client.ts` already does this.
- Tests: `imap-client.test.ts` mocks `imapflow`'s `ImapFlow` instance (`fetchAll` and so on). `imap-sync.test.ts` mocks `createImapClient` with a `mocks.client` object and mocks the logger's `warn` as `mocks.warn`. The runner is Vitest (`npm --workspace orchestrator run test:run`).

## Requirements
1. Add two exported constants in `imap-client.ts` or `imap-sync.ts` (the builder chooses which):
   - `IMAP_MAX_MESSAGE_BYTES = 1 * 1024 * 1024` (1 MiB): the most bytes kept for any single message.
   - `IMAP_MAX_SYNC_BYTES = 32 * 1024 * 1024` (32 MiB): the most message-source bytes held in memory for one sync run.
2. Add `fetchMessageSizes(uids: number[]): Promise<{ uid: number; size: number | null }[]>` to `ImapClient`. It calls `fetchAll(uids, { uid: true, size: true }, { uid: true })` and returns `size: null` when the server gives no size. It returns `[]` for an empty list without calling the server. Errors map through `toImapError` in the same way as the other methods.
3. `fetchMessageSources` takes a per-message byte limit and requests `source: { maxLength: limit }` instead of `source: true`, so oversized messages are truncated on the server. As a safeguard, any returned `source` longer than the limit is sliced down to the limit before it is returned. Sources are still fetched with BODY.PEEK, so `\Seen` is never set.
4. In `fetchRecentInboxMessages`, after the newest `maxMessages` UIDs are chosen:
   - Fetch their sizes with `fetchMessageSizes`.
   - Walk the UIDs from newest to oldest and charge each one `min(size, IMAP_MAX_MESSAGE_BYTES)`. A `null` size is charged as `IMAP_MAX_MESSAGE_BYTES`.
   - A UID is selected if its charge fits in the remaining `IMAP_MAX_SYNC_BYTES` budget. Otherwise it is skipped, and the walk continues so that smaller, older messages can still fit.
   - Fetch sources only for the selected UIDs, with the limit `IMAP_MAX_MESSAGE_BYTES`.
5. Oversized messages are truncated, not dropped: a message whose reported size is over `IMAP_MAX_MESSAGE_BYTES` is still fetched (truncated), parsed and ingested. If the truncated source fails to parse, the existing per-message error boundary in `runPostApplicationIngestion` handles it. No new handling is added.
6. Warnings, using `logger.warn` from `@infra/logger`, with structured fields only and never message content, subjects or addresses:
   - One warning per truncated message, with `provider: "imap"`, `accountKey`, `uid`, `sizeBytes` and `limitBytes`.
   - One warning per sync when any UIDs were skipped for the budget, with `provider: "imap"`, `accountKey`, `skippedCount`, `skippedUids` and `budgetBytes`.
   - No warning is logged when nothing is truncated or skipped.
7. Messages skipped for the budget are not handed to `runPostApplicationIngestion`, so they do not count toward `discovered`. `IngestionSyncSummary`, the API response shape and the shared types are unchanged.
8. Tests:
   - `imap-client.test.ts` covers `fetchMessageSizes` (query shape, `null` for a missing size, empty input) and asserts that `fetchMessageSources` sends `source: { maxLength }` and slices an over-long returned buffer.
   - `imap-sync.test.ts` (with `fetchMessageSizes` added to `mocks.client`) covers truncation with a warning, budget skipping with a warning, a smaller older message still fitting after a skip, `null` size charged at the per-message cap, and no warnings for small messages.
   - Existing assertions that change, such as the `fetchAll` call args and the `fetchMessageSources` call args, are updated rather than deleted.
9. Update the existing IMAP credentials bullet area of `AGENTS.md` ("Webhook and LLM Payload Defaults") with one line. It should say that IMAP sync truncates each message to `IMAP_MAX_MESSAGE_BYTES` and caps the per-sync total at `IMAP_MAX_SYNC_BYTES`, skipping messages beyond the budget with a warning, and name the file the constants live in.

## Acceptance criteria
1. `grep -rn "IMAP_MAX_MESSAGE_BYTES\|IMAP_MAX_SYNC_BYTES" orchestrator/src/server/services/post-application/ingestion/` shows both constants exported, with values 1 MiB and 32 MiB, and used in `imap-sync.ts`.
2. `grep -n "source: true" orchestrator/src/server/services/post-application/ingestion/imap-client.ts` returns nothing. `grep -n "maxLength" ` on the same file finds the partial fetch.
3. `npm --workspace orchestrator run test:run -- imap-client` passes. It includes tests for:
   - `fetchMessageSizes` calling `fetchAll(uids, { uid: true, size: true }, { uid: true })`
   - a missing size mapping to `null`
   - `fetchMessageSources` passing `source: { maxLength: <limit> }`
   - a returned source longer than the limit coming back sliced to exactly the limit
4. `npm --workspace orchestrator run test:run -- imap-sync` passes. It includes tests showing that:
   - a message reported at more than 1 MiB is fetched, ingested (upserted) and produces exactly one `warn` call with `uid`, `sizeBytes` and `limitBytes`
   - when the sizes add up to more than 32 MiB, the over-budget UIDs are absent from the `fetchMessageSources` call args, and one `warn` call carries `skippedCount` and `skippedUids`
   - a smaller, older UID is still fetched after a larger one is skipped
   - a sync of small messages calls `warn` zero times for size reasons
5. No `warn` call in the new tests includes a subject, body or email address. The tests assert the warning objects with `toHaveBeenCalledWith(<message>, expect.objectContaining({...}))` and the field set in Requirement 6.
6. `AGENTS.md` contains the new line naming both constants.
7. All CI-parity checks from AGENTS.md pass from the repo root:
   - `./orchestrator/node_modules/.bin/biome ci .`
   - `npm run check:types:shared`
   - `npm --workspace orchestrator run check:types`
   - `npm --workspace gradcracker-extractor run check:types`
   - `npm --workspace ukvisajobs-extractor run check:types`
   - `npm --workspace orchestrator run build:client`
   - `npm --workspace orchestrator run test:run`

## Out of scope
- Making the limits configurable (env vars, settings UI, route parameters).
- Changing the Gmail sync path, `message-ingest.ts` counting, `IngestionSyncSummary`, shared types or the API response.
- Streaming parse or switching from `fetchAll` to an incremental fetch iterator.
- Recording skipped or truncated messages in the database, or surfacing them in the Tracking Inbox UI.
- Changing `maxMessages` or `searchDays` defaults or route limits.
- Docs-site pages. A follow-up for the existing backlog item that updates `docs-site` post-application pages could mention the limits.

## Assumptions
- **Truncate rather than skip for per-message oversize.** Job emails with large attachments (offer letters, interview packs) usually have their headers and text body before the attachment parts. Keeping them serves "No lost or mis-routed applications".
- **Skip for the per-sync budget.** Truncating further cannot bound total memory once every message is at the cap. The budget is filled newest-first with a greedy fit.
- **1 MiB per message and 32 MiB per sync.** Typical recruiter emails are well under 100 KB. With the default of 100 messages the budget is rarely hit, and the worst case is bounded far below the current 500 full sources. These are product-tunable numbers.
- **Constants, not configuration.** This is the smallest change that meets the request.
- **Two IMAP round trips (sizes, then sources).** This lets the budget be decided before any source bytes are held in memory, and it stays read-only.
- **No tenant scoping work.** The change adds no state, caches or storage, only constants and per-call local variables.

## Mission fit
Fits: hardens the self-hosted IMAP post-application email tracking ("Tracking applications, interviews and post-application email"; "Self-hosting and operating the app in Docker").
