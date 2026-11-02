VERDICT: PASS

## Findings
None.

## Notes
The branch has no user-facing change. It touches only server-side IMAP ingestion (`imap-client.ts`, `imap-sync.ts`, their tests) and one line in `AGENTS.md`. No client files, routes, copy or API response shapes changed (`IngestionSyncSummary` is unchanged per the spec), so there is nothing to check for flow, states, accessibility or mobile. I did not start the dev server or the browser.
