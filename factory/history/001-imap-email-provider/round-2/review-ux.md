VERDICT: PASS

## Findings
None.

## Notes
Reviewed from the diff only. I did not run the dev server or a browser.
- Round 1 had no findings. The only change since then is commit 0e9656c, which is server-side: it blocks IMAP connect and sync in public demo mode. The client form is unchanged.
- In demo mode the visitor now gets an API error, which the page shows through the existing action error toast. No new dead end.
- Optional, carried over: suggest port 143 when the TLS switch is turned off.
