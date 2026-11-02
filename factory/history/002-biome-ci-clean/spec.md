# Make `biome ci .` pass repo-wide

> Feature: Make `biome ci .` pass repo-wide: fix the 23 existing errors on main (formatting/lint only, no behaviour changes), including factory/dashboard.html and factory/settings.json, and exclude generated or vendored files in biome.json if they are the cause

## Context

- CI runs Biome 2.3.12 as `biome ci .` (`.github/workflows/ci.yml`, job "Linting (Biome)"). Locally the same check is `./orchestrator/node_modules/.bin/biome ci .` (`npm run check:all`), the first item in AGENTS.md "Required CI-parity checks".
- Config is `biome.json` at the repo root. `files.includes` already force-excludes build output and runtime folders with `!!` entries (`!!**/dist`, `!!docs-site/.docusaurus`, `!!.claude`, `!!**/data`, `!!**/storage`, ...). There is no `vcs` block, so Biome does not read `.gitignore`.
- On main at `93f4eee`, `biome ci .` reports **24 errors** (23 at the time of the request, plus `factory/history/001-imap-email-provider/job.json` recorded since), 1 warning and 3 infos. They fall in two groups:
  1. **fm-factory tooling files under `factory/`** (not app code):
     - `factory/dashboard.html`: `lint/suspicious/noControlCharactersInRegex` (x2, line 577), `lint/style/useTemplate` (x3, infos, unsafe fix only), `lint/style/noDescendingSpecificity` (warning, line 221). This file is a byte-for-byte copy of the plugin asset `fm-factory/skills/factory/assets/dashboard.html`, placed by `/fm-factory:init`.
     - `factory/settings.json`: format (the factory writes 2-space JSON with arrays expanded; Biome wants collapsed short arrays). Rewritten by `/fm-factory:init` and `/factory gate`.
     - `factory/history/<job-id>/job.json`: format (tab-indented, written by the factory orchestrator on every merged job).
     - `factory/jobs/` is gitignored runtime job state, but because Biome ignores `.gitignore` here it is also linted in the main checkout.
  2. **App source, 18 files**, all format or `assist/source/organizeImports` errors, all fixable with Biome's safe fixes:
     - `orchestrator/src/client/components/JobBriefPane.tsx`
     - `orchestrator/src/client/components/tailoring/TailoringWorkspace.tsx`
     - `orchestrator/src/client/components/tailoring/useTailoringDraft.ts`
     - `orchestrator/src/client/pages/SettingsPage.tsx`
     - `orchestrator/src/client/pages/settings/components/JudgmentEngineSection.tsx`
     - `orchestrator/src/client/pages/settings/components/ModelSettingsSection.tsx`
     - `orchestrator/src/server/api/routes/jobs/actions.ts`
     - `orchestrator/src/server/pipeline/orchestrator.ts`
     - `orchestrator/src/server/services/jev/email-routing.ts` and `email-routing.test.ts`
     - `orchestrator/src/server/services/jev/job-scoring.ts` and `job-scoring.test.ts`
     - `orchestrator/src/server/services/jev/project-ranking.test.ts`
     - `orchestrator/src/server/services/projectSelection.test.ts`
     - `orchestrator/src/server/services/resume-renderer/typst.test.ts`
     - `orchestrator/src/server/services/rxresume/tailoring.ts`
     - `orchestrator/src/server/services/scorer.ts` and `scorer.test.ts`
     - `shared/src/settings-registry.ts`
- A dry run in a scratch copy confirmed the fix below: add `"!!factory"` to `files.includes`, then `biome check --write .` (safe fixes only) touches exactly those 18 files plus `biome.json`, and `biome ci .` then reports no errors.

## Requirements

1. Add `"!!factory"` to `files.includes` in `biome.json`, alongside the existing `!!` exclusions, so all fm-factory tooling files (vendored dashboard, generated settings, history records and runtime job state) are outside Biome's scope. Keep `biome.json` itself Biome-formatted.
2. Do not edit any file under `factory/`. They are vendored from or written by the fm-factory plugin, and hand edits would be overwritten (settings, history) or drift from the plugin asset (dashboard).
3. Fix the 18 app source files listed in Context by running `./orchestrator/node_modules/.bin/biome check --write .` from the repo root (safe fixes only: formatting and import ordering). Do not use `--unsafe`.
4. The diff to the app source files is whitespace, line wrapping and import order only: no renamed identifiers, changed logic, changed strings, added or removed imports, or `biome-ignore` comments.
5. Add one line to AGENTS.md under "Validation / Verification" saying that `factory/` (fm-factory tooling: vendored dashboard and generated settings/records) is excluded from Biome in `biome.json` and must not be hand-formatted.
6. All AGENTS.md "Required CI-parity checks" pass.

## Acceptance criteria

1. `./orchestrator/node_modules/.bin/biome ci .` run from the repo root exits 0 and prints no errors (warnings/infos from non-excluded files, if any, must not be errors).
2. `biome.json` contains `"!!factory"` in `files.includes`; `git diff main -- biome.json` shows only that addition.
3. `git diff --stat main -- factory/` is empty.
4. `git diff --stat main` lists only `biome.json`, `AGENTS.md` and the 18 source files named in Context.
5. `git diff -w main -- orchestrator shared` shows only line-wrapping and import-reordering hunks (no token-level changes beyond moved import lines and wrapping), and `git diff main -- orchestrator shared | grep -c biome-ignore` prints `0`.
6. `grep -n "factory" AGENTS.md` shows the new note about the Biome exclusion under "Validation / Verification".
7. `npm run check:types:shared`, `npm --workspace orchestrator run check:types`, `npm --workspace gradcracker-extractor run check:types`, `npm --workspace ukvisajobs-extractor run check:types`, `npm --workspace orchestrator run build:client` and `npm --workspace orchestrator run test:run` all pass (proving no behaviour change).

## Out of scope

- Hand-fixing `factory/dashboard.html` (the control-character regex, template literals, CSS specificity) or reformatting `factory/settings.json` / `factory/history/**/job.json`. If the dashboard lint findings matter, they belong upstream in the fm-factory plugin asset.
- Applying Biome unsafe fixes, or changing lint rule levels or the formatter config in `biome.json`.
- Adding a `vcs` block (`useIgnoreFile`) to `biome.json`; it would change what Biome scans repo-wide.
- Any logic, refactor or test changes in the touched source files.
- Changing `.github/workflows/*` or the Biome version.
- Anything under `docs/` or `docs-site/`.

## Assumptions

- The `factory/` files are excluded rather than fixed: the request allows exclusion when generated or vendored files are the cause, and all three are (dashboard is identical to the plugin asset; settings and job.json are rewritten by the factory), so fixing them would regress on the next job.
- Exclude the whole `factory/` folder rather than individual files: new `factory/history/<id>/job.json` records and gitignored `factory/jobs/` state appear with every job, and the folder holds no app code (the rest is Markdown, which Biome does not check).
- The error count is 24, not 23: the extra error is the job 001 history record added after the request was written; it is covered by the same exclusion.

## Mission fit
Fits: keeps the CI checks green for self-hosting and operating the app ("Self-hosting and operating the app in Docker"), with no product change.
