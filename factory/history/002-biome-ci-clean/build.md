STATUS: READY

# Build: Make `biome ci .` pass repo-wide

## Summary
`biome.json` now force-excludes `factory/` (`"!!factory"` in `files.includes`), so the fm-factory dashboard, settings, history records and runtime job state are outside Biome's scope. The 18 app source files were fixed with `biome check --write .` (safe fixes only: formatting and import ordering). AGENTS.md has a one-line note about the exclusion under "Validation / Verification".

Commits:
- `8cb18f4` chore: exclude factory/ tooling files from Biome (`biome.json`, `AGENTS.md`)
- `68074ed` style: apply Biome safe fixes to app source (the 18 files listed in the spec)

Files changed: `biome.json`, `AGENTS.md`, `orchestrator/src/client/components/JobBriefPane.tsx`, `.../tailoring/TailoringWorkspace.tsx`, `.../tailoring/useTailoringDraft.ts`, `orchestrator/src/client/pages/SettingsPage.tsx`, `.../settings/components/JudgmentEngineSection.tsx`, `.../settings/components/ModelSettingsSection.tsx`, `orchestrator/src/server/api/routes/jobs/actions.ts`, `orchestrator/src/server/pipeline/orchestrator.ts`, `.../jev/email-routing.ts`, `.../jev/email-routing.test.ts`, `.../jev/job-scoring.ts`, `.../jev/job-scoring.test.ts`, `.../jev/project-ranking.test.ts`, `.../services/projectSelection.test.ts`, `.../resume-renderer/typst.test.ts`, `.../rxresume/tailoring.ts`, `.../services/scorer.ts`, `.../services/scorer.test.ts`, `shared/src/settings-registry.ts`.

## Acceptance criteria
1. [x] `biome ci .` exits 0 with no errors: `./orchestrator/node_modules/.bin/biome ci .` -> "Checked 1108 files ... No fixes applied.", exit 0, with no errors, warnings or infos.
2. [x] `"!!factory"` is in `files.includes`: `git diff main -- biome.json` shows only `"!!**/storage"` -> `"!!**/storage",` plus the new `"!!factory"` line. The comma is needed to add the entry.
3. [x] `git diff --stat main -- factory/` is empty (0 lines).
4. [x] `git diff --stat main` lists exactly `AGENTS.md`, `biome.json` and the 18 spec files (21 files, +163/-60).
5. [x] Formatting/import-order only. `git diff main -- orchestrator shared | grep -c biome-ignore` prints `0`. I checked tokens per file: I stripped whitespace and compared the character counts of each file on main and on the branch. 10 files match exactly. The other 8 differ only by extra `,` characters, which are trailing commas the formatter adds when it wraps argument lists and arrays. `JudgmentEngineSection.tsx` has one more difference: JSX text `Effective: X ·\n Default: Y` became `Effective: X{" "}\n· Default: Y`. That is the formatter keeping the same rendered whitespace, so the text on screen does not change. No identifiers, strings or logic changed, and no imports were added or removed. Only one import was rewrapped (`JUDGMENT_ENGINE_*`).
6. [x] `grep -n "factory" AGENTS.md` -> line 120: "`factory/` (fm-factory tooling: vendored dashboard and generated settings/records) is excluded from Biome via `!!factory` in `biome.json`; do not hand-format files there." It sits under "Validation / Verification", right after the Required CI-parity checks list.
7. [x] Type checks, client build and tests all pass (see Validation).

## Validation
All run from the worktree root on Node v22.23.4:
- `./orchestrator/node_modules/.bin/biome ci .`: pass (exit 0)
- `npm run check:types:shared`: pass
- `npm --workspace orchestrator run check:types`: pass
- `npm --workspace gradcracker-extractor run check:types`: pass
- `npm --workspace ukvisajobs-extractor run check:types`: pass
- `npm --workspace orchestrator run build:client`: pass
- `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm --workspace orchestrator run test:run`: pass. 321 test files passed; 2388 tests passed and 2 were skipped.
  - Note: this host's default locale is `en_GB.UTF-8`. With that locale, one test fails: `src/client/pages/WatchlistPage.test.tsx` > "shows new rows by default with ignore actions". It expects the date text "May 1, 2026", but this locale renders "1 May 2026". The same test fails on unmodified `main` (I checked by stashing the changes in the worktree), so this change did not cause it. It passes under `en_US`, which is what CI uses. Changing the test is out of scope here, but it could go in the backlog.

## Log
### Round 1
- Added `"!!factory"` to `biome.json` `files.includes`.
- Ran `biome check --write .` (no `--unsafe`). My first run happened before the biome.json edit had applied, and it rewrote `factory/settings.json` and `factory/history/001-imap-email-provider/job.json`. I restored both right away with `git checkout -- factory/`. They were never committed, and the final diff against main under `factory/` is empty.
- Added the AGENTS.md note and ran the full CI-parity list. Everything passed, except the pre-existing locale-dependent WatchlistPage test described above.
- Committed in two commits. The tree is clean.
