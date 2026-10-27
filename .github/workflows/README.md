# GitHub Actions workflows

What runs in CI, when it runs, and what to do when it fails. The workflow files are the source of
truth; if this page and a file disagree, the file wins (and this page needs fixing).

## At a glance

| Workflow                                 | Runs on                                                              | Purpose                                                           |
| ---------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`ci.yml`](ci.yml) (CI Pipeline)         | push and PR to `main`/`develop`                                      | Lint, typecheck, test and build each app that changed             |
| [`e2e.yml`](e2e.yml)                     | PR touching `apps/chat-ui`, `supabase`, lockfile; manual             | Playwright against a throwaway local Supabase                     |
| [`backend-data.yml`](backend-data.yml)   | PR touching backend, `supabase`, e2e seed; nightly 03:00 UTC; manual | Database-backed backend tests and the golden-set evals            |
| [`docker.yml`](docker.yml)               | push and PR touching `apps/**` or compose files; manual              | Build images (push from `main`/`develop`), compose check, Trivy   |
| [`code-quality.yml`](code-quality.yml)   | push and PR to `main`/`develop`; Mondays 09:00 UTC; manual           | CodeQL, dependency review, audits, secret scan, licences          |
| [`pr-automation.yml`](pr-automation.yml) | PR events                                                            | Labels, title check, reviewer assignment, checklist comments      |
| [`tag-release.yml`](tag-release.yml)     | after CI Pipeline succeeds on a push to `main`; manual               | Work out the next version, tag it, start the release              |
| [`release.yml`](release.yml)             | dispatched by Tag Release; `vX.Y.Z` tag push; manual                 | Build artifacts, push versioned images, create the GitHub Release |
| [`deploy.yml`](deploy.yml)               | manual only                                                          | **Template**: the deploy and rollback steps are not wired up yet  |

Shared tool versions (Node 24, Python 3.13, pnpm 10.11.0) are repeated in each workflow's `env`
block. Change them in every file, and keep them in step with `.nvmrc` and
`apps/ai_agent/.python-version`.

## How a change flows through

```
PR opened/updated
  ├─ ci.yml            changed-area detection, then lint/typecheck/test/build
  ├─ e2e.yml           frontend or database changes only
  ├─ backend-data.yml  backend or database changes only
  ├─ docker.yml        images build (not pushed), compose check, Trivy
  ├─ code-quality.yml  CodeQL, dependency review, secret scan
  └─ pr-automation.yml labels, title check

merge to main
  └─ ci.yml ──(success)──► tag-release.yml ──(releasable commits)──► tag vX.Y.Z
                                                                        │
                                              release.yml ◄─────────────┘ (dispatched)
                                                    │
                                   artifacts + ghcr.io images + GitHub Release

deploy.yml  ← run by hand, against a published version (template only)
```

## `ci.yml`: CI Pipeline

Cancels an in-progress run for the same ref when a new push arrives.

```
changes ──┬─► frontend-lint ────────┐
          ├─► frontend-typecheck ───┴─► frontend-build ────┐
          │                                                ├─► ci-success
          ├─► backend-lint ─────┐                          │
          ├─► backend-typecheck ┤                          │
          ├─► backend-security ─┼─► backend-build ─────────┘
          └─► backend-test ─────┘
```

- **`changes`** uses `dorny/paths-filter`. _Frontend_ is `apps/chat-ui/**`, root `package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `ci.yml`. _Backend_ is `apps/ai_agent/**` or `ci.yml`.
  The jobs for a side with no changes are skipped.
- **Frontend**
  - `frontend-lint`: `prettier --check` on `apps/chat-ui`, then `pnpm lint` (ESLint).
  - `frontend-typecheck`: `pnpm typecheck:react-router`.
  - `frontend-build`: `pnpm build:react-router`, after lint and typecheck pass. Uploads the
    `chat-ui-build` artifact (7 days).
- **Backend** (Poetry, run in `apps/ai_agent`; the Poetry cache is keyed on `poetry.lock`)
  - `backend-lint`: Black, isort, flake8 (`--max-line-length=90`).
  - `backend-typecheck`: `mypy src/`.
  - `backend-security`: `bandit -r src/ -ll`.
  - `backend-test`: `pytest tests/` with coverage, uploaded to Codecov (an upload error does not
    fail the job). There is no database here, so tests that need one skip themselves; they run in
    `backend-data.yml`.
  - `backend-build`: `poetry build`, after the four jobs above pass. Uploads `ai-agent-dist`.
- **`ci-success`** always runs and fails if a side that changed did not end in `success`. A skipped
  side is fine. Use this as the single required status check in branch protection.

## `e2e.yml`: Playwright

Starts a local Supabase stack inside the runner (`supabase start`, minus the services the app does
not use), writes `.env.test` (`pnpm e2e:env`) and seeds it (`pnpm e2e:seed`). It never touches a
hosted project: the e2e tooling refuses to run unless `SUPABASE_URL` is localhost.

- **`e2e`**: the read-only specs, in 4 parallel shards, each with its own database. Each shard runs
  all six projects (desktop, tablet and mobile, each in light and dark).
- **`e2e-mutations`**: the `*-edit.spec.ts` specs that change data, in their own job and database so
  they cannot skew a figure another test is checking.
- Playwright browsers are cached by Playwright version. A failed job uploads its
  `playwright-report-*` artifact (7 days); download it for traces and screenshots.

## `backend-data.yml`: database tests and evals

- **`data-tests`** (every relevant PR, so it can gate a merge): same local Supabase and seed as
  e2e, then the database-backed pytest files (`test_scoped_sql`, `test_chat_agent`, `test_actions`,
  `test_evals`, `test_ui_contract`) and the golden-set evals against the _oracle_, a scripted
  perfect model that needs no API key. It tests our machinery (tools, middleware, scoring,
  tenancy). Report: `evals-oracle` artifact (14 days).
- **`real-model-evals`** (nightly and manual, never on a PR): the same golden set against the real
  model, which needs the `GOOGLE_API_KEY` secret. Without the key the job passes and says it was
  skipped. Report: `evals-real` artifact (30 days). See `apps/ai_agent/docs/evals.md`.

## `docker.yml`

- **`build-chat-ui`**: context is the **repo root** with `apps/chat-ui/Dockerfile`. Only the
  `VITE_LANGGRAPH_*` values are baked in as build args; Supabase and agent config are supplied at
  runtime.
- **`build-ai-agent`**: context `apps/ai_agent`. Its Dockerfile is unmodified `langgraph build`
  output.
- Images go to `ghcr.io/<owner>/<repo>/chat-ui` and `.../ai-agent`. Pull requests build but do not
  push. Pushes to `main`/`develop` tag by branch, SHA, and `latest` on the default branch.
- **`docker-compose-test`** (PRs): runs `docker compose config` on the compose files. The compose
  files are known to be stale, so this checks syntax only.
- **`security-scan`**: builds each image and runs Trivy (CRITICAL and HIGH), uploading SARIF to the
  repository's Security tab.
- **`docker-success`**: fails if either image build failed.

## `code-quality.yml`

CodeQL (JavaScript and Python), dependency review (PRs only; fails on moderate or worse and denies
GPL-3.0 and LGPL-3.0, with `pglast` explicitly allowed), `npm audit`, a Python security audit,
TruffleHog (verified secrets only), a coverage report and a licence summary. The summary job fails
only if CodeQL or secret scanning failed; the audits and licence check are informational.

## `pr-automation.yml`

- **PR title must be Conventional Commits**: `type(scope): Subject`.
  - Types: `feat fix docs style refactor perf test build ci chore revert`.
  - Scopes (optional): `frontend backend chat-ui ai-agent deps ci docker db`.
  - The subject must start with a capital letter.
  - This matters beyond style: with squash merges the title becomes the commit message, which
    decides the release version (below).
- Also: labels from changed paths (`.github/labeler.yml`) and PR size, reviewer assignment
  (`.github/auto-assign.yml`), a first-time contributor greeting, a checklist comment, issue
  linking, a `needs-tests` warning when code changes without test files, and a summary comment.

## Releases

Fully automatic. Nobody creates tags by hand.

1. A push to `main` runs CI Pipeline. When it succeeds, `tag-release.yml` starts (pull request runs
   are ignored).
2. It only acts on the **tip** of `main`. If a newer commit has landed, the newer run handles it,
   and the release then covers every commit since the previous tag.
3. `.github/scripts/next-version.sh` reads the Conventional Commit messages since the last
   `vX.Y.Z` tag (merge commits are ignored):

   | Commit                                    | Bump  |
   | ----------------------------------------- | ----- |
   | `type!:` or a `BREAKING CHANGE:` footer   | major |
   | `feat`                                    | minor |
   | `fix`, `perf`, `revert`                   | patch |
   | `docs chore ci test refactor style build` | none  |

   With no tag yet the base is `v0.0.0`, so the first release is `v0.1.0`. If nothing releasable
   landed, no tag is created.

4. It pushes an annotated tag and **dispatches `release.yml` itself**, because a tag pushed with
   `GITHUB_TOKEN` does not trigger other workflows.
5. `release.yml` builds the frontend and the Python package into `threadwise-<version>.tar.gz`,
   pushes both Docker images to ghcr.io (`<version>`, `<major>.<minor>`, `<major>`, `latest`),
   generates a changelog from commits, and creates the GitHub Release. It does **not** re-run CI;
   it relies on `tag-release.yml` only tagging green commits.

Useful commands:

```bash
.github/scripts/next-version.sh            # preview the next version from HEAD
.github/scripts/next-version.sh <commit>   # ... or from a specific commit
```

- Dry run in CI: Actions → **Tag Release** → Run workflow (`dry_run` is on by default).
- Release by hand: Actions → **Release** → Run workflow with a `vX.Y.Z` version.
- The version lives in the git tag only. `package.json` and `pyproject.toml` are not updated.

## `deploy.yml`: not functional yet

Manual dispatch with an environment (`development`, `staging`, `production`) and an optional
version. It validates the input, checks the images exist, waits for manual approval on production,
runs migrations, health-checks and has a rollback job. The **deploy, rollback and parts of the
health-check steps are placeholders** (`TODO: Customize this section`), so running it does not
deploy anything real. Wire it to the real hosting target before relying on it.

## Dependabot

`.github/dependabot.yml`, weekly: GitHub Actions on Monday, npm (root and `apps/chat-ui`) on
Tuesday, pip (`apps/ai_agent`) on Wednesday, Docker (`apps/ai_agent`) on Thursday. Related packages
are grouped, and major bumps of critical dependencies are ignored.

## Secrets and variables

Nothing here is required for a pull request to pass. The default `GITHUB_TOKEN` covers labelling,
ghcr.io pushes and releases.

| Secret                                                        | Used by                                 | If missing                                        |
| ------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | `ci.yml` build, `release.yml` artifacts | The build runs with empty values                  |
| `VITE_LANGGRAPH_API_URL`, `VITE_LANGGRAPH_ASSISTANT_ID`       | `docker.yml` chat-ui image              | URL defaults to `http://localhost:2024`; ID empty |
| `GOOGLE_API_KEY`                                              | `backend-data.yml` real-model evals     | Evals are skipped, not failed                     |
| `CODECOV_TOKEN`                                               | coverage uploads                        | Upload may fail; it never fails the job           |
| `DATABASE_URL`                                                | `deploy.yml` migrations                 | Deploy only                                       |

Never put real secrets in a tracked file. See "Known issues" in the root `CLAUDE.md` for the
exposed-credential history note.

## Reproduce a CI failure locally

Run from the repo root unless noted. Mirror the workflow file, not `package.json`, when in doubt.

| Failing job        | Command                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend lint      | `pnpm exec prettier --check "apps/chat-ui/**/*.{ts,tsx,js,jsx,json,css,md}"` and `pnpm lint`                                                                  |
| Frontend typecheck | `pnpm typecheck:react-router`                                                                                                                                 |
| Frontend build     | `pnpm build:react-router`                                                                                                                                     |
| Backend lint       | `cd apps/ai_agent && poetry run black --check src/ tests/ && poetry run isort --check-only src/ tests/ && poetry run flake8 src/ tests/ --max-line-length=90` |
| Backend typecheck  | `cd apps/ai_agent && poetry run mypy src/`                                                                                                                    |
| Backend security   | `cd apps/ai_agent && poetry run bandit -r src/ -ll`                                                                                                           |
| Backend tests      | `cd apps/ai_agent && poetry run pytest tests/ -v`                                                                                                             |
| E2E                | `pnpm db:start && pnpm db:fresh && pnpm e2e:quick` (needs Docker and the Supabase CLI)                                                                        |
| Backend data tests | `pnpm db:fresh`, then `cd apps/ai_agent && poetry run pytest tests/test_scoped_sql.py tests/test_chat_agent.py tests/test_actions.py`                         |
| Docker (chat-ui)   | `docker build -f apps/chat-ui/Dockerfile -t threadwise-chat-ui .`                                                                                             |

Tips:

- Run Prettier from the **repo root** (`pnpm exec prettier ...`). The copy inside `apps/chat-ui`
  can resolve an older version after a partial install and format differently; `pnpm install` fixes
  a mismatch.
- Run the backend tests without a `.env`, as CI does. `tests/conftest.py` sets `INNGEST_DEV=1`;
  without it every module that imports the app fails at collection.
- `pnpm e2e:quick -- --last-failed` re-runs only the failures.
- An e2e failure that only happens in CI: download the `playwright-report-*` artifact from the run.

## Known gaps

- `docker-compose*.yml` is stale, so the compose check only validates syntax. Don't treat a green
  result as proof the stack starts.
- `deploy.yml` is a template (above).
- Frontend lint in CI runs `pnpm lint`, which is `eslint . --fix`. It passes on a clean tree, but it
  can rewrite files on the runner instead of reporting fixable problems.
- Frontend unit tests do not exist; the frontend is covered by Playwright only.
- Several third-party actions are not pinned to a version (`trufflehog@main`,
  `trivy-action@master`).
