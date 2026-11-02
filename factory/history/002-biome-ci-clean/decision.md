APPROVE

## Why
The branch adds `"!!factory"` to `biome.json` `files.includes`, applies Biome safe fixes (formatting and import order only) to the 18 listed app source files, and adds a one-line note to AGENTS.md. All four reviewers in round 1 returned PASS with no findings, and `git merge-tree --write-tree main factory/002-biome-ci-clean` merges cleanly. Nothing under `factory/`, `docs/`, `.claude/` or `.github/` changes, and no dependency is added. The `biome.json` edit is lint scope, not CI, deploy or build config. It excludes only fm-factory tooling files, which the request explicitly allowed.

## Acceptance criteria
1. `biome ci .` exits 0 with no errors: met. I re-ran it in the worktree and got "Checked 1108 files ... No fixes applied.", exit 0.
2. `"!!factory"` is in `files.includes` and the diff shows only that addition: met. I checked `git diff` myself. The only other change is the comma that a new array entry needs.
3. `git diff --stat main -- factory/` is empty: met. The diff stat lists no `factory/` paths.
4. The diff stat lists only `biome.json`, `AGENTS.md` and the 18 spec files: met. It shows 21 files, and they match the spec list.
5. Formatting and import order only, with no `biome-ignore`: met. I read every hunk of `git diff -w` for orchestrator and shared myself, and each one is wrapping, trailing commas or a moved import. The one JSX text rewrap in JudgmentEngineSection (`{" "}` before `· Default:`) keeps the rendered whitespace the same.
6. The AGENTS.md note is under "Validation / Verification": met. I confirmed it sits right after the Required CI-parity checks list.
7. Type checks, client build and tests pass: met, based on the evidence in build.md. One test fails only under the en_GB locale (WatchlistPage date format). It also fails on unmodified main and passes under en_US, which CI uses. I did not re-run these checks. The code reviewer accepted the evidence, and the change is formatting only.

## For the human
Nothing to decide. Optional follow-up for the backlog: the WatchlistPage date test depends on the system locale.
