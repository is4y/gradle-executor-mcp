# GitHub Actions CI/CD Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub Actions workflows that test every PR/push to `main` and build-and-publish the Docker image to GHCR on `v*` tag pushes, gated on tests.

**Architecture:** One reusable `workflow_call` job (`test.yml`) holds the test-and-typecheck steps so both entry-point workflows stay DRY. `ci.yml` calls it on pull requests and pushes to `main`. `release.yml` calls it on `v*` tags, then a `publish` job (gated on the test job) builds the multi-stage Dockerfile and pushes to GHCR.

**Tech Stack:** GitHub Actions; `oven-sh/setup-bun`, `actions/setup-java` (Temurin 21), `gradle/actions/setup-gradle`, `docker/login-action`, `docker/metadata-action`, `docker/build-push-action`. Bun test suite + `tsc`.

## Global Constraints

- JDK version: **Temurin 21** (matches the runtime image in `Dockerfile`).
- Gradle: **latest stable**, provisioned onto `PATH` so integration tests run instead of skipping.
- Bun install: always `bun install --frozen-lockfile`.
- Image registry: **GHCR** (`ghcr.io`); auth via built-in `GITHUB_TOKEN` only — no new secrets.
- Image name derived dynamically as `ghcr.io/${{ github.repository }}` — never hardcode the owner.
- Image build happens **only** on `v*` tag pushes, never on PRs or `main` pushes.
- Image tags on a release: the git tag (e.g. `v1.2.3`) and `latest`.

---

### Task 1: Reusable test workflow

The shared test-and-typecheck job, called by both `ci.yml` and `release.yml`.

**Files:**
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Produces: a reusable workflow callable via `uses: ./.github/workflows/test.yml` with trigger `workflow_call`. Defines one job named `test`. Requires no inputs or secrets.

- [ ] **Step 1: Create the reusable workflow file**

```yaml
# .github/workflows/test.yml
name: test

on:
  workflow_call:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"

      - name: Set up Gradle
        uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: release-candidate

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Type check
        run: bun run typecheck

      - name: Run tests
        run: bun test
```

> Note: `gradle-version: release-candidate` pins the newest published Gradle. If a stable pin is preferred at execution time, replace with an explicit version (e.g. `"8.14"`). Either way Gradle lands on `PATH` and the `test.if(hasGradle)` integration tests execute.

- [ ] **Step 2: Validate the YAML parses**

Run: `bun -e "import {parse} from 'yaml'; parse(await Bun.file('.github/workflows/test.yml').text()); console.log('ok')"` (or `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/test.yml')); print('ok')"`)
Expected: prints `ok`

- [ ] **Step 3: Lint with actionlint if available**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/test.yml || echo "actionlint not installed, skipping"`
Expected: no errors reported (or the skip message)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add reusable test workflow (bun test + typecheck + gradle)"
```

---

### Task 2: CI workflow for PRs and main

Entry point that runs the test job on pull requests and pushes to `main`.

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the reusable `test` job from `.github/workflows/test.yml` (Task 1).

- [ ] **Step 1: Create the CI workflow file**

```yaml
# .github/workflows/ci.yml
name: ci

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    uses: ./.github/workflows/test.yml
```

- [ ] **Step 2: Validate the YAML parses**

Run: `bun -e "import {parse} from 'yaml'; parse(await Bun.file('.github/workflows/ci.yml').text()); console.log('ok')"`
Expected: prints `ok`

- [ ] **Step 3: Lint with actionlint if available**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/ci.yml || echo "actionlint not installed, skipping"`
Expected: no errors reported (or the skip message)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run tests on PRs and pushes to main"
```

---

### Task 3: Release workflow — build & publish to GHCR

Entry point that, on a `v*` tag, runs the tests and then builds & pushes the image.

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the reusable `test` job from `.github/workflows/test.yml` (Task 1); the multi-stage `Dockerfile` at the repo root.

- [ ] **Step 1: Create the release workflow file**

```yaml
# .github/workflows/release.yml
name: release

on:
  push:
    tags: ["v*"]

jobs:
  test:
    uses: ./.github/workflows/test.yml

  publish:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Derive image metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=semver,pattern={{version}}
            type=raw,value=latest

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

> `type=semver,pattern={{version}}` turns tag `v1.2.3` into image tag `1.2.3`; `type=raw,value=latest` adds `:latest`. The `test` job gates `publish` via `needs: test`, so a failing suite blocks the push.

- [ ] **Step 2: Validate the YAML parses**

Run: `bun -e "import {parse} from 'yaml'; parse(await Bun.file('.github/workflows/release.yml').text()); console.log('ok')"`
Expected: prints `ok`

- [ ] **Step 3: Lint with actionlint if available**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/release.yml || echo "actionlint not installed, skipping"`
Expected: no errors reported (or the skip message)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build and publish image to GHCR on version tags"
```

---

### Task 4: End-to-end verification

Confirm both pipelines behave as designed against the real GitHub runner.

**Files:**
- None (verification only).

- [ ] **Step 1: Push the branch and open a PR against `main`**

```bash
git push -u origin feat/gradle-mcp-sandbox
gh pr create --fill --base main
```

- [ ] **Step 2: Confirm the CI run is green and integration tests ran**

Run: `gh run watch` (or check the PR's Checks tab)
Expected: the `ci / test` job passes. In the "Run tests" step log, the integration tests (`list_tasks returns the project tasks`, etc.) execute rather than skip — confirming Gradle is on `PATH`.

- [ ] **Step 3: Cut a throwaway pre-release tag to exercise release.yml**

```bash
git tag v0.0.0-ci-test
git push origin v0.0.0-ci-test
```

- [ ] **Step 4: Confirm tests gate the publish and the image lands in GHCR**

Run: `gh run watch`
Expected: `release / test` runs first; `release / publish` runs only after it passes; the image appears under the repo's Packages with tags `0.0.0-ci-test` and `latest`.

- [ ] **Step 5: Clean up the throwaway tag and package version**

```bash
git push origin :refs/tags/v0.0.0-ci-test
git tag -d v0.0.0-ci-test
```
Delete the `0.0.0-ci-test` package version from the GHCR UI (or `gh api`).

---

## Self-Review

**Spec coverage:**
- Two workflow files split by trigger → Tasks 2 & 3 (plus shared Task 1). ✅
- CI on PR + push to `main`, with per-ref cancel concurrency → Task 2. ✅
- Bun + Temurin 21 + latest Gradle + frozen install + typecheck + full test suite → Task 1. ✅
- Release on `v*`, tests gate publish, GHCR via `GITHUB_TOKEN`, tag+latest, GHA layer cache → Task 3. ✅
- Out of scope (no CD, no multi-arch/signing, no image push on PR/main) → respected; nothing added. ✅
- Acceptance (test PR + throwaway tag) → Task 4. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full file content. The DRY reuse decision left open in the spec is resolved here (reusable `workflow_call` workflow). ✅

**Type/name consistency:** Reusable workflow path `.github/workflows/test.yml` and job name `test` are referenced identically in Tasks 2 & 3. Image reference `ghcr.io/${{ github.repository }}` consistent with global constraints. ✅
