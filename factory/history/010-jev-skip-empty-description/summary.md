# Skip Jev scoring for jobs with no description
Outcome: merged 2026-11-06 after 1 review rounds (0 reworks) · Mission fit: Fits

> Feature: Skip Jev scoring without a warning when a job has no description, going straight to the configured LLM

## What shipped
Jobs with no description made `scoreJobWithJev` throw, so every scoring run logged a "Jev scoring failed" warning even though nothing was wrong. `scoreJobSuitability` in `orchestrator/src/server/services/scorer.ts` now only tries Jev when `stripHtmlTags(job.jobDescription ?? "").trim()` is non-empty. Otherwise it goes straight to the configured LLM. The guard throw in `jev/job-scoring.ts` is unchanged. Tests are in `orchestrator/src/server/services/scorer.test.ts`.

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 1. Description checked before `scoreJobWithJev`, no warn when empty | Met | Check added to the Jev `if` ahead of the try/catch (build.md, decision.md) |
| 2. Guard throw kept in `jev/job-scoring.ts` | Met | grep shows line 176 still has the throw; the approver re-ran it |
| 3. New tests exist and pass | Met | `it.each` over `""`, whitespace, HTML-only and `null`, plus a normal-description test; 64 passed. The 4 empty cases fail with the fix reverted (build.md) |
| 4. Existing Jev tests still pass | Met | Same 64-test run |
| 5. CI-parity checks pass | Met | biome, all type checks, build:client, full test run (2513 passed, 2 skipped) per build.md; the code reviewer re-ran biome, types and the scorer tests |
| 6. Diff limited to scorer.ts and scorer.test.ts | Met | `git diff --stat`: 2 files, +38/-2 |

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
- [ ] Code review note: in the new warn-spy test, `mockRestore` runs at the end of the test body, so a failed assertion would skip it. Check that the suite's `afterEach` restores mocks, or move the restore into `afterEach`.
- [ ] Code review note (style only): the condition relies on `&&` with a string. `!!` or `.length > 0` would read more clearly.
- [ ] Assumption to confirm: `null` and `undefined` descriptions count as empty, matching `?? ""` in `scoreJobWithJev`.
- [ ] Not done, by the spec's choice: no info/debug log or result flag records that Jev was skipped, so the skip is invisible in logs.

## Mission fit
Fits: it cuts log noise on the Jev scoring path, and the configured LLM stays as the fallback, as the mission's in-scope Jev line requires.

Drift: none. Of the last 10 records (001-009 plus this job), all are Fits and none are Stretch.
