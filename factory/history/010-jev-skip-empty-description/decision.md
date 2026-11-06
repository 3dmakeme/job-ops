APPROVE

## Why
A small server-side change in `scoreJobSuitability`. Jobs with an empty description (after HTML strip and trim) now skip Jev and go straight to the LLM without the warning. Jobs that have a description still work as before. All four reviewers passed, and their notes are style only. The merge-tree check is clean, the diff touches only the two expected files, and nothing falls under an escalation category.

## Acceptance criteria
1. Description check before scoreJobWithJev, no warn for empty: met. The diff shows `stripHtmlTags(job.jobDescription ?? "").trim()` added to the Jev `if` condition, ahead of the try/catch that holds the warn.
2. Guard throw kept: met. I ran the grep myself, and line 176 of jev/job-scoring.ts still has the throw.
3. New tests exist and pass: met. The `it.each` covers "", whitespace, HTML-only and null, and a separate test covers a normal description. I ran `npx vitest run src/server/services/scorer.test.ts` myself: 64 passed.
4. Existing Jev tests still pass: met. They ran in the same 64-test run.
5. CI-parity checks: met per build.md (biome, all type checks, build:client, and the full test run with 2513 passed). The code review re-ran biome, types and the scorer tests.
6. Diff limited to scorer.ts and scorer.test.ts: met. `git diff main...branch --stat` shows only those two files.
