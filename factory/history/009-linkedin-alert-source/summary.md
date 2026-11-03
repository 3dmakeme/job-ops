# LinkedIn job-alert emails as a discovery source
Outcome: merged 2026-11-03 after 2 review rounds (1 rework) · Mission fit: Fits

> Feature: LinkedIn job-alert emails as a jobs source: via the existing IMAP provider, scan the connected inbox for LinkedIn job alert/notification emails (sender linkedin.com job alerts), parse the job listings in them (title, company, location, job URL) and add them as discovered jobs through the normal job ingestion path (dedupe by job URL, so repeats and existing jobs are not duplicated). Scan only the previous 7 days of mail (a fixed 7-day lookback for this source, independent of the general IMAP searchDays default of 90). Read-only on the mailbox, no LinkedIn scraping or login, no auto-apply, reuse the 1 MiB/32 MiB IMAP limits, tests with sample alert email fixtures, and a setting to turn it on or off (default off). Jobs then flow through normal scoring.

## What shipped
Pipeline runs can now read LinkedIn job-alert emails from the tenant's connected IMAP inbox and add the listings as discovered jobs (`source: "linkedin"`), which then go through the normal filters, `createJobs` URL dedupe and scoring. The scanner, parser and URL normaliser are in `orchestrator/src/server/services/linkedin-alerts/`; the source is wired into `pipeline/steps/discover-jobs.ts`; the `linkedinAlertsEnabled` setting (default off) is in `shared/src/settings-registry.ts` with a "LinkedIn Alerts" section under Settings → Integrations. The scan is read-only, looks back a fixed 7 days, reuses the 1 MiB/32 MiB limits through a shared `selectUidsWithinBudget`, and bypasses `syncWatermark`. After the rework, only links that normalise to `https://www.linkedin.com/jobs/view/<id>` produce a job.

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 1. Default settings make no IMAP connection | Met | `discover-jobs.test.ts`; rerun by approver |
| 2. Checkbox persists across reload | Met | build.md browser check; `SettingsPage.test.tsx` |
| 3. Fixture (a): 3 clean listings, repeat collapsed | Met | `alert-parser.test.ts` |
| 4. Fixtures (b), (c), (d) | Met, (d) changed by rework | (d) now dropped, not stored as given |
| 5. Normaliser cases | Met | `job-url.test.ts`; lookalike hosts, user-info trick, `javascript:`/`data:` rejected |
| 6. Scanner behaviour (7-day since, read-only, limits, close, no writes) | Met | `scanner.test.ts` |
| 7. Listings become `source: "linkedin"` inputs through filters | Met | `discover-jobs.test.ts` |
| 8. URL dedupe on import | Met | `import-dedupe.test.ts` (real DB) |
| 9. Failure and missing account add one source error | Met | non-IMAP errors now show "LinkedIn alerts: scan failed" |
| 10. Cross-tenant test | Met | `tenant-isolation.test.ts` |
| 11. AGENTS.md bullet | Met | updated in round 2 |
| 12. CI-parity checks | Met | build.md (2508 passed); code reviewer reran biome, types and targeted tests |

## Rounds
| Round | security | ux | ui | code |
|---|---|---|---|---|
| 1 | PASS | PASS | PASS | PASS |
| 2 | PASS | PASS | PASS | PASS |

Round 1 was all PASS, but the approver escalated to the owner (forged-sender alert could add jobs with attacker-chosen links; a second reader of the stored IMAP password). The owner chose option 1, "harden", through `rework-1.md`. Round 2 passed and the approver approved.

## Iterations
### 1. Forged-sender alerts could add jobs with attacker links
- **Caught by:** security reviewer, round 1 (Note 1, rated non-blocking); the approver escalated it.
- **What was wrong:** `isLinkedInAlertSender` trusts the From header, and `job-url.ts` kept any non-LinkedIn http(s) link "as given". A forged sender could add a job with a chosen title, company and link.
- **Why the builder missed it:** it followed the spec: Requirement 7 said to store the link as given, and fixture (d) and criterion 5 required that behaviour. The security reviewer judged it against the spec and its limited impact (own job list, no server-side fetch, `javascript:`/`data:` rejected) and recorded a Note.
- **Fix:** `normalizeLinkedInJobUrl` returns null unless the result is `https://www.linkedin.com/jobs/view/<id>`; exact `linkedin.com` or `.linkedin.com` host match; http(s) only.

### 2. Quadratic parse time on crafted HTML-only email
- **Caught by:** security reviewer, round 1 (Note 2).
- **Why missed:** the spec capped bytes but not listings or links per email.
- **Fix:** `LINKEDIN_ALERT_MAX_JOB_LINKS` (100) in both paths and `MAX_CARD_DEPTH` (10).

### 3. Raw error messages could reach source errors
- **Caught by:** security reviewer, round 1 (Note 3).
- **Why missed:** Requirement 9 said to surface `error.message`; the builder applied it to every error.
- **Fix:** only `ImapAuthenticationError` and `ImapConnectionError` messages are copied; everything else is "LinkedIn alerts: scan failed" with detail logged via `sanitizeUnknown`.

### 4. Docs and tests describing the old rule
- Followed from iteration 1; the AGENTS.md bullet and a parser test name were updated.

## Proposed guardrails
| Where | Add | Prevents |
|---|---|---|
| AGENTS.md (spec-writer rules) | "If a feature stores or links a URL taken from inbound email, a web page or any other third-party content, the spec must say how it is reduced to an allowlisted form and what happens to links that do not fit. Default is to drop them, not keep them as given. Add a negative test with a lookalike host." | Untrusted links stored as given |
| AGENTS.md (spec-writer rules) | "A parser over untrusted input must have a count cap (listings, links, nesting depth) in the acceptance criteria, in addition to byte caps, with a test." | Quadratic parse time on crafted input |
| AGENTS.md (spec-writer rules) | "When a requirement says to show an error message in the UI or run output, name the error classes whose message may be shown. All others get a fixed generic message, with detail logged server-side." | Raw internal error text in user-visible output |
| AGENTS.md (spec-writer rules) | "If a source reads email From addresses to decide trust, state in Assumptions that the From header can be forged and say what limits the damage." | A trust assumption first questioned in a reviewer Note |

## Follow-ups
- [ ] Update four docs-site pages: `features/settings.md`, `features/pipeline-run.md`, `features/post-application-tracking.md`, `extractors/overview.md`.
- [ ] Optional: warn next to the checkbox when it is on and no IMAP account is connected.
- [ ] Hosted mode: the LinkedIn Alerts section is visible although the Tracking Inbox link is hidden there.
- [ ] The shared source id `"linkedin"` carries a native-radius flag that alert jobs inherit; check the location filter treats them correctly (unverified).
- [ ] The sender allowlist (`jobalerts-noreply@linkedin.com`, `jobs-listings@linkedin.com`) is a product call.
- [ ] Only the `"default"` IMAP account key is scanned.
- [ ] Optional hardening: require DKIM/DMARC pass in `Authentication-Results` before trusting the sender.
- [ ] Confirm the cap of 100 links per email (the rework example said 50).
- [ ] Second reader of the stored IMAP password: the owner saw this in the escalation and chose to proceed.

## Mission fit
Fits: discovering jobs through the user's own mail server, read-only, no auto-apply. Drift: none.
