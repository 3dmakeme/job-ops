STATUS: READY

# Build: LinkedIn job-alert emails as a discovery source

## Summary
When the new per-tenant `linkedinAlertsEnabled` setting is on (default off), each pipeline run's discovery step scans the tenant's `"default"` IMAP account for LinkedIn job-alert emails, parses their listings and adds them as `source: "linkedin"` discovered jobs. They then go through the existing location and blocked-company filters, `importJobsStep` / `createJobs` (URL dedupe) and scoring.

The scan:
- opens INBOX read-only and searches `SINCE now-7d FROM linkedin.com` (fixed `LINKEDIN_ALERT_LOOKBACK_DAYS = 7`);
- takes the newest 100 UIDs and applies the shared 1 MiB / 32 MiB budget (`selectUidsWithinBudget`, now exported from `imap-sync.ts`, which also logs the truncation and skip warnings);
- fetches with `IMAP_MAX_MESSAGE_BYTES` and always closes the client;
- keeps only senders in `LINKEDIN_ALERT_SENDERS`;
- never reads or writes `syncWatermark` or any integration state.

Parsing uses the text/plain part when there is one and the HTML (jsdom) otherwise. After the round-2 rework (`rework-1.md`):
- **Only clean LinkedIn job links produce a job.** A listing is kept only if its link normalises to `https://www.linkedin.com/jobs/view/<id>` (with `sourceJobId`). The link must be http(s), on `linkedin.com` or a subdomain, and have a `/jobs/view/<id>`, `/comm/jobs/view/<id>` or `/jobs/view/<slug>-<id>` path, given directly or as an encoded redirect query value. Everything else is dropped: non-LinkedIn hosts, look-alike hosts, links without a job id and other schemes. Links are never stored as given.
- **Parsing is capped.** At most `LINKEDIN_ALERT_MAX_JOB_LINKS` (100) job links are read per email, in both the text and the HTML paths. The HTML card search climbs at most 10 ancestors.
- **Error messages.** IMAP errors still produce `LinkedIn alerts: <message>`. Any other scan failure produces only `LinkedIn alerts: scan failed`, and the sanitized detail goes to the server log through `logger.warn`.

Failures never abort a run. The Settings page has an Integrations → LinkedIn Alerts section with one checkbox.

Files changed (whole branch):
- `shared/src/settings-registry.ts`, `shared/src/types/settings.ts`, `shared/src/testing/factories.ts`: the setting.
- `orchestrator/src/server/services/post-application/ingestion/imap-client.ts` (+ test): `searchUidsSinceFrom`.
- `orchestrator/src/server/services/post-application/ingestion/imap-sync.ts`: exported `selectUidsWithinBudget` and `PARSER_OPTIONS`.
- `orchestrator/src/server/services/linkedin-alerts/`:
  - `job-url.ts`, `alert-parser.ts`, `scanner.ts`;
  - tests `job-url.test.ts`, `alert-parser.test.ts`, `scanner.test.ts`, `tenant-isolation.test.ts`, `import-dedupe.test.ts`;
  - `__fixtures__/` with the four `.eml` fixtures (a)–(d).
- `orchestrator/src/server/pipeline/steps/discover-jobs.ts` (+ test).
- `orchestrator/src/server/pipeline/orchestrator.ts`.
- `orchestrator/src/client/pages/SettingsPage.tsx` (+ test), `orchestrator/src/client/pages/settings/types.ts`, `orchestrator/src/client/pages/settings/components/LinkedInAlertsSettingsSection.tsx`.
- `AGENTS.md`: the LinkedIn alerts bullet.

## Acceptance criteria
Requirement 7 and fixture (d) were changed by `rework-1.md`; criteria 4 and 5 are checked against the new rule.

1. [x] Default settings make no IMAP connection: `discover-jobs.test.ts` "makes no IMAP connection and adds no source when the setting is unset" checks that `createImapClient` is never called, `crawlingSourcesTotal` stays 1 and the fanout sources are `["indeed"]`. Further cases cover the setting set to `"0"` and `includeLinkedInAlerts: false`.
2. [x] The checkbox persists:
   - Round 1, in the browser: the built app on port 5190 at `/settings#linkedin-alerts`. I checked the box and saved; the DB row was `linkedinAlertsEnabled|1`, and after a reload the box was still checked with an "On" badge.
   - Test: `SettingsPage.test.tsx` "saves the LinkedIn alerts toggle and shows it checked after reload".
   - The UI did not change in round 2.
3. [x] Fixture (a): `alert-parser.test.ts` gives 3 listings with exact title/company/location, clean `jobUrl` and `sourceJobId`, with the repeated listing collapsed.
4. [x] All in `npm --workspace orchestrator run test:run -- linkedin-alerts discover-jobs` (6 files, 78 tests passed):
   - Fixture (b) (HTML only) gives its 2 listings.
   - Fixture (c) gives zero listings: the sender is not allowlisted, and the scanner reports `matchedSenderCount: 0`.
   - Fixture (d) now gives zero listings because its link has no derivable id. `alert-parser.test.ts` "drops a job link without a derivable id, fixture (d)" asserts `[]`, and the scanner test now expects 5 listings from fixtures (a)–(d).
   - "drops forged listings that point outside LinkedIn job pages" covers both the text and HTML paths: `evil.example/linkedin.com/jobs/view/1`, `linkedin.com.evil.example`, and a `careers.evil.example` job page are all dropped, and only the real LinkedIn links remain.
5. [x] `job-url.test.ts`:
   - Normalised to `https://www.linkedin.com/jobs/view/123`: `/comm/jobs/view/123/?trackingId=x`, `uk.linkedin.com/jobs/view/senior-data-lead-at-acme-123`, a trailing-slash link, and a URL-encoded redirect wrapper.
   - Rejected (`null`):
     - a non-LinkedIn job page;
     - the look-alike hosts `linkedin.com.evil.example` and `evillinkedin.com`;
     - `evil.example/linkedin.com/jobs/view/1`;
     - the user-info trick `www.linkedin.com@evil.example`;
     - a LinkedIn redirect around a non-LinkedIn page;
     - a LinkedIn job link with no id;
     - another LinkedIn page;
     - `javascript:`, `data:`, `mailto:` and `ftp:` URLs;
     - a non-http(s) redirect value;
     - text that is not a URL.
6. [x] `scanner.test.ts` covers everything below. No IMAP behaviour changed in round 2.
   - the search uses `since` about 7 days back and `from: "linkedin.com"`;
   - INBOX is opened with `openInboxReadOnly`;
   - `fetchMessageSources` gets `IMAP_MAX_MESSAGE_BYTES`;
   - messages beyond the 32 MiB budget are skipped with a warning;
   - the client is closed on success and on error;
   - no integration or mailbox writes happen;
   - the stored credentials and `syncWatermark` are untouched.
7. [x] `discover-jobs.test.ts`: with the setting on, `source: "linkedin"` `CreateJobInput`s pass through the location filter (the Berlin listing is dropped) and the blocked-company filter (Demo Cloud is dropped).
8. [x] `import-dedupe.test.ts` (real DB): the same listing twice creates 1 job, and a repeat run skips it.
9. [x] A connection failure and a missing account each add one `LinkedIn alerts: ...` source error without throwing (`discover-jobs.test.ts`, `scanner.test.ts`). New `scanner.test.ts` cases cover non-IMAP failures:
   - a repository error and a `TypeError` during the inbox read each give exactly `LinkedIn alerts: scan failed`;
   - the client is still closed;
   - the detail is logged through `logger.warn` with the sanitized error.
10. [x] `tenant-isolation.test.ts` (real DB): tenant B gets "no IMAP account connected" and `createImapClient` is never called; tenant A's scan uses tenant A's credentials.
11. [x] The `AGENTS.md` bullet now covers the drop-don't-store rule, the per-email job-link cap and the generic non-IMAP error, along with everything from round 1.
12. [x] All seven CI-parity checks pass (see Validation).

## Validation
Re-run in round 2 from the worktree root:
- `./orchestrator/node_modules/.bin/biome ci .`: pass. I formatted only the changed files with `biome check --write <paths>`.
- `npm run check:types:shared`: pass.
- `npm --workspace orchestrator run check:types`: pass.
- `npm --workspace gradcracker-extractor run check:types`: pass.
- `npm --workspace ukvisajobs-extractor run check:types`: pass.
- `npm --workspace orchestrator run build:client`: pass.
- `npm --workspace orchestrator run test:run`: pass, 327 files, 2508 passed and 2 skipped.

## Log
### Round 1
I built the feature as specified, in five commits:
1. The setting.
2. The shared budget helper and `searchUidsSinceFrom`.
3. The scanner, parser and URL normaliser with fixtures, plus the pipeline integration and tests.
4. The Settings UI.
5. The AGENTS.md bullet.

Decisions and notes for reviewers:
- **Budget reuse.** `selectUidsWithinBudget` moved its warnings inside the helper, so both callers log the same lines. The post-application sync behaviour is unchanged.
- **Text parsing.** A line counts as a job link when it starts with "View job" or holds a LinkedIn job link. Any other URL line ends the current block. When a block has more than 3 lines, the 3 lines closest to the link are used.
- **HTML parsing.** Anchors are grouped by job id, and the first anchor with text gives the title. The card is the closest ancestor that has text outside links and holds no other job's link. Its text is split on `·`, `•` and `|`, giving company first and location second.
- **Text part only.** An email with a non-empty text/plain part is parsed only from that part, with no fallback to HTML (as the spec says).
- **Repeats across emails.** The scanner also collapses repeated job URLs across emails in one scan.
- **Hosted usage.** The source counts as one unit in `totalSources` (hosted `job_search` reservation), and it counts as used only on a scan without error. This mirrors the Watchlist.
- **Location filter flag.** LinkedIn alert jobs share `source: "linkedin"`, so they inherit that source's `nativeRadiusApplied` flag when JobSpy's LinkedIn source is in the same run.
- **Hosted mode.** The LinkedIn Alerts settings section is not hidden in hosted mode. The spec did not ask for that.
- **Declined: product docs.** I did not touch `docs-site/` or `docs/`. The spec lists the product docs as a follow-up, and the factory keeps product documentation outside the build.
- **Browser check setup.** I seeded onboarding flags and a default design resume in a scratch DB under the scratchpad to reach the Settings page; nothing in the repo changed for this. I stopped the server and closed the browser afterwards.

### Round 2 (rework-1.md)
The owner chose option (a) on the approver's escalation (`decision.md`): harden the parser against forged alert emails. Each rework item and what I did:

1. **Drop listings that cannot be normalised.**
   - Change: `normalizeLinkedInJobUrl` now returns `null` unless it can produce the clean `https://www.linkedin.com/jobs/view/<id>` form, and `sourceJobId` is now always set. Only linkedin.com hosts, including inside an encoded redirect parameter, can produce a job.
   - Change: I removed `isLinkedInJobLink`. The HTML path keeps only anchors that normalise. The text path still treats a "View job" line as a link line, but a non-normalisable link drops the listing.
   - Tests: fixture (d) is now asserted to give no listing. New look-alike, path-trick, user-info, non-LinkedIn-redirect and scheme rejection cases were added in `job-url.test.ts`, plus forged text and HTML emails in `alert-parser.test.ts`.
   - Commit: `963879c`.
2. **Cap job links per email.**
   - Change: `LINKEDIN_ALERT_MAX_JOB_LINKS = 100` applies to link lines in the text path and to job anchors in the HTML path; the anchor loop stops once the cap is reached.
   - Choice of value: I chose 100 rather than the suggested 50 because real alerts carry up to about three links per listing (logo, title, button), so 50 anchors could cut off a genuine alert.
   - Extra: the HTML card search now climbs at most 10 ancestors, so deeply nested crafted markup cannot make each lookup walk the whole document.
   - Tests:
     - a 120-listing text email returns exactly 100;
     - a 5000-card HTML-only email returns exactly 100, well under the 5 s bound in the test;
     - a card whose text sits 50 levels above the link is not reached.
   - Commit: `ed40d57`.
3. **Generic message for non-IMAP errors.**
   - Change: only `ImapAuthenticationError` / `ImapConnectionError` messages, which never carry server responses, are copied into the source error. Anything else becomes `LinkedIn alerts: scan failed`, and the detail is logged through `logger.warn` with `sanitizeUnknown(error)`; no email content or credentials are logged.
   - Unchanged: the "no IMAP account connected" handling.
   - Tests: two new cases in `scanner.test.ts`.
   - Commit: `3328f60`.
4. **AGENTS.md and test text.**
   - Change: I updated the AGENTS.md bullet to describe the drop-don't-store rule, the cap and the generic error (`c94838e`).
   - Change: I renamed the parser test that mentioned a "usable link". No fixture text described storing links as given. Fixture (d) is unchanged and now serves as the negative case.
   - Unchanged: everything else.
   - Re-run: all seven CI-parity checks pass.

Note: commit `963879c` on its own does not type-check, because the parser still imported the removed `isLinkedInJobLink` until `ed40d57`. The branch tip is clean.
