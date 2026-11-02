# Backlog

`/fm-factory:factory next` builds the first unchecked item and checks it off
with its job id. Items depend on the ones above them.

- [x] Make `biome ci .` pass repo-wide: fix the 23 existing errors on main (formatting/lint only, no behaviour changes), including factory/dashboard.html and factory/settings.json, and exclude generated or vendored files in biome.json if they are the cause → 002-biome-ci-clean
- [x] IMAP sync: cap the size of each fetched message and the total memory used per sync (skip or truncate oversized messages, log a warning), with tests → 003-imap-size-cap
- [x] Update docs-site pages post-application-tracking.md and post-application-workflow.md to describe the IMAP provider (MxRoute example, password stored encrypted, CREDENTIALS_ENCRYPTION_KEY, INBOX read-only sync) → 004-imap-docs-update
- [x] Encrypt existing Gmail access and refresh tokens at rest using credential-crypto.ts, with a safe one-off migration of existing rows (idempotent, backs up first, still reads legacy plaintext values) → 006-gmail-token-encryption
- [x] Make WatchlistPage.test.tsx ("shows new rows by default with ignore actions") locale-independent: it expects "May 1, 2026" but renders "1 May 2026" under en_GB, and fails on unmodified main → 005-watchlist-locale-test

- [ ] LinkedIn job-alert emails as a jobs source: via the existing IMAP provider, scan the connected inbox for LinkedIn job alert/notification emails (sender linkedin.com job alerts), parse the job listings in them (title, company, location, job URL) and add them as discovered jobs through the normal job ingestion path (dedupe by job URL, so repeats and existing jobs are not duplicated). Read-only on the mailbox, no LinkedIn scraping or login, no auto-apply, reuse the 1 MiB/32 MiB IMAP limits, tests with sample alert email fixtures, and a setting to turn it on or off (default off). Jobs then flow through normal scoring.
