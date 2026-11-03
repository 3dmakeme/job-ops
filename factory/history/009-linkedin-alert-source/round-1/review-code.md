VERDICT: PASS

## Checks
- `./orchestrator/node_modules/.bin/biome ci .`: pass
- `npm run check:types:shared`: pass
- `npm --workspace orchestrator run check:types`: pass
- `npm --workspace orchestrator run test:run -- linkedin-alerts discover-jobs imap SettingsPage`: pass (10 files, 189 tests)
- Not re-run by me: extractor type checks, `build:client`, full test run (build.md reports them passing; the change doesn't touch those workspaces).

## Findings
None.

## Notes
- The scanner never touches `syncWatermark` or integration writes, and the setting-off path makes no IMAP connection. Both match the spec.
- `selectUidsWithinBudget` now logs its own warnings and takes `accountKey`. This is a small, sensible refactor, and the post-application behaviour is unchanged.
- `scanner.ts` returns the same "no IMAP account connected" error when the password can't be decrypted. This matches the spec.
- Hosted mode shows the LinkedIn Alerts settings section even though the Tracking Inbox link is hidden. This is non-blocking and build.md already flags it.
- The product docs in `docs-site/` are now out of date on the settings, pipeline run and extractor pages. The spec records this as a follow-up.
