APPROVE

## Why
The round-2 rework covers all four owner-requested items from the earlier escalation. Forged-sender listings can now only point at clean `https://www.linkedin.com/jobs/view/<id>` URLs. Parsing is capped, and non-IMAP errors show only a generic message. All four round-2 reviews (security, ux, ui, code) are `VERDICT: PASS`, and their notes raise no real problem. The branch merges into main with no conflicts. It touches no `.claude/`, `factory/`, `docs/`, CI, deploy or dependency files and adds no migration. The owner already saw the credential-reuse question in the round-1 escalation and chose to proceed with hardening option 1.

## Acceptance criteria
1. Default settings make no IMAP connection: met. `discover-jobs.test.ts` covers the setting unset, set to `"0"` and `includeLinkedInAlerts: false`. I reran it and it passes.
2. Checkbox persists across reload: met. build.md records a browser check (DB row `linkedinAlertsEnabled|1`, still checked after reload), there is a `SettingsPage.test.tsx` case, and the UI has not changed since round 1.
3. Fixture (a) gives 3 clean listings with the repeat collapsed: met (`alert-parser.test.ts`, passes in my rerun).
4. Fixtures (b), (c) and (d): met under the rework-1 rule. (b) gives 2 HTML-only listings, (c) gives 0 because its sender is not allowlisted, and (d) is now dropped as the rework requires.
5. Normaliser cases: met. I read `job-url.ts` myself. The scheme must be http(s), the host must be exactly `linkedin.com` or end in `.linkedin.com` (checked on `URL.hostname`), and the path regex is anchored. The output is always built from a fixed origin plus a `\d+` id, and anything else returns null. Tests cover look-alike hosts, the user-info trick and `javascript:`/`data:` URLs.
6. Scanner behaviour (7-day since, `from: "linkedin.com"`, read-only open, `IMAP_MAX_MESSAGE_BYTES`, budget skip warning, close always called, no integration writes, watermark untouched): met (`scanner.test.ts` passes, and the security review confirms it).
7. Setting-on listings become `source: "linkedin"` inputs that go through the location and blocked-company filters: met (`discover-jobs.test.ts`).
8. URL dedupe on import: met (`import-dedupe.test.ts`, real DB).
9. A connection failure and a missing account each add one source error without throwing: met (discover-jobs and scanner tests).
10. Cross-tenant test: met (`tenant-isolation.test.ts`).
11. AGENTS.md bullet: met. It is the only AGENTS.md change, and it is updated for the rework.
12. CI-parity checks: met according to build.md (full suite: 2508 passed). The code reviewer reran biome, the type checks and the targeted tests. My own rerun of linkedin-alerts and discover-jobs gave 6 files and 78 tests, all passing.
