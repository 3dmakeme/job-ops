# Backlog

`/fm-factory:factory next` builds the first unchecked item and checks it off
with its job id. Items depend on the ones above them.

- [x] Make `biome ci .` pass repo-wide: fix the 23 existing errors on main (formatting/lint only, no behaviour changes), including factory/dashboard.html and factory/settings.json, and exclude generated or vendored files in biome.json if they are the cause → 002-biome-ci-clean
- [x] IMAP sync: cap the size of each fetched message and the total memory used per sync (skip or truncate oversized messages, log a warning), with tests → 003-imap-size-cap
- [ ] Update docs-site pages post-application-tracking.md and post-application-workflow.md to describe the IMAP provider (MxRoute example, password stored encrypted, CREDENTIALS_ENCRYPTION_KEY, INBOX read-only sync)
- [ ] Encrypt existing Gmail access and refresh tokens at rest using credential-crypto.ts, with a safe one-off migration of existing rows (idempotent, backs up first, still reads legacy plaintext values)
- [ ] Make WatchlistPage.test.tsx ("shows new rows by default with ignore actions") locale-independent: it expects "May 1, 2026" but renders "1 May 2026" under en_GB, and fails on unmodified main
