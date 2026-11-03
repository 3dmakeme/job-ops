VERDICT: PASS

## Checks
- `./orchestrator/node_modules/.bin/biome ci .`: pass
- `npm --workspace orchestrator run check:types`: pass
- `npm --workspace orchestrator run test:run -- linkedin-alerts discover-jobs imap SettingsPage`: pass (10 files, 199 tests)

## Findings
None.

## Notes
- All four rework items are done.
  - `normalizeLinkedInJobUrl` returns null for anything that isn't a clean LinkedIn job link. The host check is exact `linkedin.com` or a `.linkedin.com` suffix, and only http(s) is accepted.
  - `LINKEDIN_ALERT_MAX_JOB_LINKS` (100) caps both the text and the HTML paths, and card-depth climbing is capped at 10.
  - Non-IMAP scan errors now show the generic "LinkedIn alerts: scan failed" message, with the detail logged server-side.
  - The AGENTS.md bullet is updated.
- The cap is 100, not the 50 the rework gave as an example. The rework said "for example", so this is acceptable.
- `sourceJobId` is now required in the types, which fits the new behaviour.
