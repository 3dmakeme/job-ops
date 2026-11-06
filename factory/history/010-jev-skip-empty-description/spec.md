# Skip Jev scoring for jobs with no description

> Feature: In orchestrator/src/server/services/scorer.ts scoreJobSuitability, skip the Jev attempt without logging a warning when the job has no description (after the same HTML-strip and trim that jev/job-scoring.ts uses), so it goes straight to the configured LLM. Keep the throw in scoreJobWithJev as a guard. Add a test covering: empty/whitespace/HTML-only description does not call scoreJobWithJev and does not log a warn; a normal description still uses Jev. Small change, no docs, no AGENTS.md edits.

## Context
- `orchestrator/src/server/services/scorer.ts`, `scoreJobSuitability` (around lines 298-311): when `!options.briefOnly && (await shouldUseJev("scoringEngine"))`, it calls `scoreJobWithJev(job, profile)` in a try/catch. Any throw logs `logger.warn("Jev scoring failed; using the configured LLM", { jobId, error })` and falls through to the LLM.
- `orchestrator/src/server/services/jev/job-scoring.ts`, `scoreJobWithJev` (around lines 171-177): computes `stripHtmlTags(job.jobDescription ?? "").slice(0, JOB_DESCRIPTION_CHAR_LIMIT)` and throws `"Job has no description for Jev to score"` when `!description.trim()`. So today every job with no description produces a warn log on each scoring run, even though nothing is wrong.
- `stripHtmlTags` comes from `@shared/utils/string` (replaces tags with spaces, then normalises whitespace). `scorer.ts` already imports it (line 8), so no new import is needed. Slicing doesn't change whether the text is empty, so the check is `stripHtmlTags(job.jobDescription ?? "").trim()` being empty.
- Tests: `orchestrator/src/server/services/scorer.test.ts` has a `describe("Jev scoring engine")` block (around line 1163) that mocks `./jev/client` (`shouldUseJevMock`) and `./jev/job-scoring` (`scoreJobWithJevMock`), sets up settings and an LLM `callJsonMock`, and builds jobs with `createJob` from `@shared/testing/factories`. The repo spies on the logger with `vi.spyOn(logger, "warn")` and imports `logger` from `@infra/logger` (see `orchestrator/src/server/auth/sso/config.test.ts`).

## Requirements
1. In `scoreJobSuitability`, when the job's description is empty after `stripHtmlTags(job.jobDescription ?? "").trim()` (null, undefined, `""`, whitespace only, or HTML tags only), do not call `scoreJobWithJev` and do not log a warning. Scoring goes straight to the configured LLM path, the same as when Jev is not selected.
2. When the description has text, the Jev path works exactly as it does today, including the existing warn and fall-through when `scoreJobWithJev` throws.
3. Keep the `throw` in `scoreJobWithJev` (`jev/job-scoring.ts`) as is.
4. Add tests in the existing `describe("Jev scoring engine")` block in `orchestrator/src/server/services/scorer.test.ts`. They cover: (a) descriptions of `""`, whitespace only (for example `"   \n\t "`), HTML only (for example `"<p> </p><br/>"`) and `null`. For each one, `scoreJobWithJevMock` is not called, `logger.warn` is not called, and the result comes from the LLM (score 77, reason "LLM reason"). (b) A normal description (for example `"Build things"`) still calls `scoreJobWithJevMock`.
5. Keep the change small. Use the existing `stripHtmlTags` import and don't add new helpers, options or settings.

## Acceptance criteria
1. `orchestrator/src/server/services/scorer.ts` checks the description before it calls `scoreJobWithJev` and returns no warn for an empty description. Verify by reading the Jev block in `scoreJobSuitability`.
2. `orchestrator/src/server/services/jev/job-scoring.ts` still contains `throw new Error("Job has no description for Jev to score")`. Verify with `grep -n "no description for Jev" orchestrator/src/server/services/jev/job-scoring.ts`.
3. The new tests from Requirement 4 exist and pass: `npm --workspace orchestrator run test:run -- src/server/services/scorer.test.ts` (or `cd orchestrator && npx vitest run src/server/services/scorer.test.ts`).
4. The existing Jev tests in `scorer.test.ts` still pass: below-cutoff skip, at-cutoff brief, LLM fallback on Jev failure, and `generateJobBrief` never calling Jev.
5. All the CI-parity checks in AGENTS.md pass from the repo root: `./orchestrator/node_modules/.bin/biome ci .`, `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace gradcracker-extractor run check:types`, `npm --workspace ukvisajobs-extractor run check:types`, `npm --workspace orchestrator run build:client`, `npm --workspace orchestrator run test:run`.
6. `git diff main --stat` shows changes only to `orchestrator/src/server/services/scorer.ts` and `orchestrator/src/server/services/scorer.test.ts`.

## Out of scope
- Changing or removing the guard in `scoreJobWithJev`, or its tests in `jev/job-scoring.test.ts`.
- Changing the warn message or the fall-through behaviour for real Jev failures.
- Adding a log at info or debug level for the skip, or a reason or flag in the result saying Jev was skipped.
- Changing how descriptions are fetched, stored or enriched for jobs that have none.
- Any edits to `docs/` or `AGENTS.md`.

## Assumptions
- `null` and `undefined` descriptions count as empty, the same as `""`. Reason: `scoreJobWithJev` treats them as `""` via `?? ""`.
- The order relative to `shouldUseJev` is up to the builder. Reason: either order meets the request, and the tests only check that `scoreJobWithJev` is not called and no warn is logged.
- The skip applies only to `scoreJobSuitability`. Reason: `generateJobBrief` and `briefOnly` never call Jev anyway.

## Mission fit
Fits: it cuts log noise on the Jev scoring path, and "the configured LLM as fallback" stays intact, as the mission's in-scope Jev line requires.
