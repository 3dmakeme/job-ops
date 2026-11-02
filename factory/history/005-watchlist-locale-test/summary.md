# Make the WatchlistPage "Posted" date assertion locale-independent
Outcome: merged 2026-11-02 after 1 review round (0 reworks) · Mission fit: Fits

> Feature: Make WatchlistPage.test.tsx ("shows new rows by default with ignore actions") locale-independent: it expects "May 1, 2026" but renders "1 May 2026" under en_GB, and fails on unmodified main

## What shipped
The test "shows new rows by default with ignore actions" hard-coded "May 1, 2026", so it failed on hosts with an en_GB locale (and in western time zones). The assertion now computes the expected text with the same `Intl.DateTimeFormat(undefined, { dateStyle: "medium" })` call the component uses. Only `orchestrator/src/client/pages/WatchlistPage.test.tsx` changed (4 lines added, 1 removed, commit `e40518e`).

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 1. en_GB run passes | Met | build.md: 8/8; decision.md re-ran under en_GB: 8/8 |
| 2. en_US run passes | Met | build.md: 8/8; code reviewer confirmed |
| 3. TZ=America/Los_Angeles passes | Met | build.md: 8/8; decision.md spot-check 8/8 |
| 4. No `"May 1, 2026"` in test file | Met | grep returned nothing (build.md, decision.md) |
| 5. Only the test file changed | Met | `git diff --stat main...branch`: one file |
| 6. CI-parity checks pass | Met | build.md Validation: biome, type checks, client build, 2398 tests passed / 2 skipped |

## Rounds
| Round | security | ux | ui | code |
|---|---|---|---|---|
| 1 | PASS | PASS | PASS | PASS |

## Iterations
None: every reviewer passed round 1.

## Proposed guardrails
| Where | Add | Prevents |
|---|---|---|

## Follow-ups
- [ ] Other locale- or time-zone-dependent tests elsewhere in the repo were out of scope and were not searched. Unverified whether any exist.
- [ ] The `"2026-05-01"` literal is repeated in the test instead of read from `backendJob.postedAt` (typed `string | null`, would need a cast). The two could drift apart.
- [ ] The code reviewer did not run the full CI-parity list; only build.md reports it, and decision.md accepted that.

## Mission fit
Fits: a test-only fix so the CI-parity suite passes on the owner's machine; it supports "Self-hosting and operating the app in Docker" and touches nothing in Out of scope.

Drift: none. The last three records (001, 002, 003) and this one are all Fits.
