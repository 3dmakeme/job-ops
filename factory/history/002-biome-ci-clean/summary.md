# Repo-wide biome clean
Outcome: merged 2026-11-02 after 1 review round (0 reworks) · Mission fit: Fits

> Feature: Make `biome ci .` pass repo-wide: fix the 23 existing errors on main (formatting/lint only, no behaviour changes), including factory/dashboard.html and factory/settings.json, and exclude generated or vendored files in biome.json if they are the cause

## What shipped
`biome ci .` failed on main with 24 errors: 18 app source files with format or import-order problems, plus fm-factory tooling files under `factory/` that the plugin writes or vendors. The change adds `"!!factory"` to `files.includes` in `biome.json`, so the tooling files are out of Biome's scope. It also applies Biome's safe fixes (formatting and import order only) to the 18 app files in `orchestrator/` and `shared/`. AGENTS.md has a one-line note that `factory/` is excluded and must not be hand-formatted. Nothing under `factory/` was edited.

## Acceptance criteria
| Criterion | Result | Evidence |
|---|---|---|
| 1. `biome ci .` exits 0 with no errors | Met | build.md: "Checked 1108 files ... No fixes applied.", exit 0. The approver and the code reviewer re-ran it with the same result. |
| 2. `"!!factory"` in `files.includes`; diff shows only that addition | Met | The diff adds the entry plus the comma the new array entry needs (decision.md, review-code.md). |
| 3. `git diff --stat main -- factory/` is empty | Met | The code reviewer re-checked it and it was empty. The diff stat lists no `factory/` paths. |
| 4. Diff lists only `biome.json`, `AGENTS.md` and the 18 spec files | Met | `git diff --stat main...branch` shows 21 files, +163/-60. |
| 5. Wrapping and import order only; no `biome-ignore` | Met | The `biome-ignore` count is 0. The approver read every `git diff -w` hunk. Security and UI reviewers read the same diff and found only wrapping, trailing commas and moved imports. The one JSX rewrap in `JudgmentEngineSection.tsx` (`{" "}` before `· Default:`) renders the same text. |
| 6. AGENTS.md note under "Validation / Verification" | Met | AGENTS.md line 120, right after the Required CI-parity checks list. |
| 7. Type checks, client build and tests pass | Met | build.md: all type checks and `build:client` pass. Tests: 321 files and 2388 tests pass under `en_US`. No reviewer re-ran these; they relied on build.md. One test (`WatchlistPage.test.tsx`) fails under the host's `en_GB` locale. It also fails on unmodified main. |

## Rounds
| Round | security | ux | ui | code |
|---|---|---|---|---|
| 1 | PASS | PASS | PASS | PASS |

## Iterations
None: every reviewer passed round 1.

One near-miss is worth recording, even though no reviewer raised it. build.md's log says the builder's first `biome check --write .` ran before the `biome.json` edit had taken effect. It rewrote `factory/settings.json` and `factory/history/001-imap-email-provider/job.json`. The builder noticed and ran `git checkout -- factory/` straight away. Nothing was committed, and the final `factory/` diff is empty.
- **Caught by:** the builder, before commit (not a reviewer)
- **What was wrong:** a repo-wide `--write` run touched vendored or generated files under `factory/` that the spec says not to edit.
- **Why the builder missed it:** the spec says to run `biome check --write .` (requirement 3) and to add the exclusion (requirement 1), but it does not say which to do first. The builder ran the fix before the exclusion was in effect (per build.md).
- **Guardrail:** an ordering note in the spec for jobs like this one. Acceptance criterion 3 (empty `factory/` diff) already catches any leftover, so no new check is needed.

## Proposed guardrails
| Where | Add | Prevents |
|---|---|---|
| AGENTS.md, spec-writer rules | "When a requirement runs a repo-wide auto-fix (`--write`, `--fix`), list the scope or exclusion change as an earlier step, and keep an acceptance criterion that the diff is empty for excluded paths." | A repo-wide fix rewriting vendored or generated files before the exclusion applies. |
| AGENTS.md, validation commands | "Tests that format dates must pin a locale or run with `LANG=en_US.UTF-8`. The CI-parity test run must use `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`." | A false failure of `WatchlistPage.test.tsx` on non-US hosts, which wastes time in the build step. |

## Follow-ups
- [ ] Make `orchestrator/src/client/pages/WatchlistPage.test.tsx` ("shows new rows by default with ignore actions") locale-independent. It expects "May 1, 2026" but renders "1 May 2026" under `en_GB`, and it fails on unmodified main. (Notes from the code reviewer and the approver.)
- [ ] Report the lint findings in the plugin asset `fm-factory/skills/factory/assets/dashboard.html` upstream. These are `noControlCharactersInRegex` (x2, line 577), `useTemplate` (x3) and `noDescendingSpecificity`. The spec put fixing them out of scope.
- [ ] Human to confirm: `factory/` is now excluded from Biome wholesale. Any non-Markdown file added there later, including hand-written code, will go unlinted.
- [ ] Tests, build and type checks were not re-run by any reviewer, so they rest on the builder's output in build.md. The approver also did not re-run them. This is low risk for a formatting-only diff.

## Mission fit
Fits: it keeps the CI checks green for self-hosting and operating the app, and changes no product behaviour.

Drift: none. The only earlier record is 001-imap-email-provider (Fits), so there are no Stretch verdicts in the last 10 records.
