# Mission: JobOps (Richard's fork)

The boundary every factory spec in this repo is checked against. It describes what the project is for, not a list of features. Changes go through the *Amendments* log, agreed by the stakeholders below.

**Source:** /fm-factory:mission interview 2026-11-02

## Purpose
Help one job seeker run a faster, higher-quality job search: find roles across many boards, score fit, tailor the CV for each role, and track every application. The user applies to every job themselves.

## Users
- The job seeker who owns this JobOps install (Richard Swindells, executive AI and data leadership roles).
- Other self-hosters using the same install, as accounts on it.

## In scope
- Discovering and scoring jobs across job boards and watchlists.
- Tailoring CV content per job (summary, headline, skills, competencies, project selection) and rendering it to PDF with a chosen theme.
- Tracking applications, interviews and post-application email.
- Cheap, calibrated judgment calls (selection, routing, scoring) through TypeSafe Jev, with the configured LLM as fallback.
- Self-hosting and operating the app in Docker.

## Out of scope
- "Automatically submitting applications or filling in application forms." JobOps does not auto-apply.
- "Using Jev to write text." Summaries, tailoring, job briefs and Ghostwriter stay on the configured LLM.
- "Changing upstream DaKheera47/job-ops from this fork." Work lands on the `3dmakeme/job-ops` fork only; there are no PRs or pushes to `origin`.
- "Committing the CV PDF or any API key." `Dec2025_Richard_Swindells_CV_.pdf` and `.env` stay untracked.
- Becoming a hosted multi-customer service or a recruiter/employer-side product.

## Constraints
- Every server-side change is multi-tenant by default (tenant-scoped storage, caches, files, queues), per `AGENTS.md`.
- API routes keep the `{ ok, data | error, meta.requestId }` contract and its status-code mapping.
- Jev is optional: the app must work with no `TYPESAFE_API_KEY` and fall back to the LLM if a Jev call fails.
- The SQLite database and the 854 existing jobs must survive migrations.
- External services: job boards, the configured LLM provider, TypeSafe Jev, Reactive Resume, and the user's own mail server (MxRoute IMAP, Gmail). No new third-party data processors without agreement.

## Success measures
- A search-to-tailored-PDF run takes minutes, not hours, with the CV format preserved.
- LLM spend per scored job falls, and Jev agrees with the LLM on "worth applying" (the first test found 0.96 rank agreement).
- No lost or mis-routed applications and no leaked secrets.

## Stakeholders
| Who | Role in scope decisions |
|---|---|
| Richard Swindells | Owner of this fork; decides all scope changes |

## Amendments
| Date | Change | Triggered by | Agreed by |
|---|---|---|---|
