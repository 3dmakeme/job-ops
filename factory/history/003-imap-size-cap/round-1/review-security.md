VERDICT: PASS

## Findings
None.

## Notes
- The change closes the memory-exhaustion risk flagged in `factory/history/001-imap-email-provider/`. Sources are now fetched with a partial `BODY.PEEK[]<0.maxBytes>` (`imap-client.ts:150-153`), so `\Seen` is still never set and the IMAP session stays read-only. Over-long returned buffers are copied down to the limit (`imap-client.ts:157-163`).
- The per-sync budget relies on the `RFC822.SIZE` the server reports (`imap-sync.ts:140-166`). If a server is misbehaving or hostile and under-reports sizes (for example `0` for every message), the budget won't hold. In that case the real cap is `maxMessages * IMAP_MAX_MESSAGE_BYTES`, which is up to 500 MiB at the route maximum. Also, a server that ignores the partial range still makes the client buffer the full source before the slice. Both are much better than the unbounded behaviour before this change, and the IMAP host is chosen by the account owner, so I'm not blocking on them. A possible hardening step for later: during ingestion, charge the actual `source.length` against the budget as a second check, or lower `maxMessages` when no sizes are reported.
- Warnings log only `provider`, `accountKey`, `uid`, `sizeBytes`, `limitBytes`, `skippedCount`, `skippedUids` and `budgetBytes`. They contain no subjects, bodies, addresses or credentials. `accountKey` was already logged elsewhere in this ingestion path (`message-ingest.ts`). `skippedUids` can hold at most `maxMessages` integers (500), so the log entry stays small.
- No new state, caches or storage are added. The constants are global, but they hold no tenant data, so tenant scoping doesn't change. There are no new dependencies, secrets or `.env` changes in the diff.
- secure-endpoint: no concerns. No endpoint, route handler or action is added or changed. The change sits behind the existing IMAP sync route, and its auth, validation and `maxMessages` bounds are untouched. Checked items 1-13 (4, 12 and 13 n/a: no impersonation and no Next.js/Python stack in scope).
