STATUS: READY

# Build: Skip Jev scoring for jobs with no description

## Summary
`scoreJobSuitability` now only tries Jev when `stripHtmlTags(job.jobDescription ?? "").trim()` is non-empty (checked before `shouldUseJev`, using the existing import). Jobs with a null, empty, whitespace-only or HTML-only description go straight to the configured LLM without calling `scoreJobWithJev` and without the "Jev scoring failed" warn. Jobs with a description behave as before, including warn and fall-through on a real Jev failure. The guard throw in `jev/job-scoring.ts` is untouched.

Files changed:
- `orchestrator/src/server/services/scorer.ts`
- `orchestrator/src/server/services/scorer.test.ts`

Commit: `e0bff62 fix: skip Jev scoring for jobs with no description`

## Acceptance criteria
1. [x] scorer.ts checks the description before calling `scoreJobWithJev`: the Jev `if` in `scoreJobSuitability` is now `!options.briefOnly && stripHtmlTags(job.jobDescription ?? "").trim() && (await shouldUseJev("scoringEngine"))`, so an empty description never enters the try/catch and never reaches the warn.
2. [x] Guard kept: `grep -n "no description for Jev" orchestrator/src/server/services/jev/job-scoring.ts` -> `176:    throw new Error("Job has no description for Jev to score");`
3. [x] New tests in `describe("Jev scoring engine")`: an `it.each` over `""`, `"   \n\t "`, `"<p> </p><br/>"` and `null` asserts `scoreJobWithJevMock` not called, a `vi.spyOn(logger, "warn")` spy not called, and score 77 / reason "LLM reason"; plus "still calls Jev for a job with a description" (`"Build things"`) asserts `scoreJobWithJevMock` called once. `cd orchestrator && npx vitest run src/server/services/scorer.test.ts` -> 64 passed. With the scorer.ts change reverted, the 4 empty-description cases fail (confirmed the tests catch the bug).
4. [x] Existing Jev tests (below-cutoff skip, at-cutoff brief, LLM fallback on Jev failure, generateJobBrief never calls Jev) pass in the same run.
5. [x] All CI-parity checks passed from the worktree root (see Validation).
6. [x] `git diff main --stat` -> only `orchestrator/src/server/services/scorer.test.ts` (+31) and `orchestrator/src/server/services/scorer.ts` (+7/-2).

## Validation
- `./orchestrator/node_modules/.bin/biome ci .`: pass (1121 files, no fixes)
- `npm run check:types:shared`: pass
- `npm --workspace orchestrator run check:types`: pass
- `npm --workspace gradcracker-extractor run check:types`: pass
- `npm --workspace ukvisajobs-extractor run check:types`: pass
- `npm --workspace orchestrator run build:client`: pass
- `npm --workspace orchestrator run test:run`: pass (2513 passed, 2 skipped)
- No UI change, so no browser check was needed.

## Log
### Round 1
Added the empty-description check to the Jev condition in `scoreJobSuitability` and five new test cases (four empty variants via `it.each`, one normal description). Ran biome format on the two changed files only (no changes). Ran the targeted test, verified the new tests fail without the fix, then ran the full CI-parity list. No docs or AGENTS.md edits were requested or made.
