# Bun-Compile Docker Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the container image as a two-stage build that compiles the server to a standalone binary with `bun build --compile` and ships it on a slim JDK runtime.

**Architecture:** A builder stage on `oven/bun:1-debian` compiles `src/server.ts` into a single executable; a runtime stage on `eclipse-temurin:21-jdk-jammy` receives only that binary plus the JDK Gradle needs. The runtime user changes from the Bun image's `bun` user to a new `app` user, so the `docker-compose.yml` Gradle-cache volume path moves to match.

**Tech Stack:** Docker multi-stage build, Bun 1.x (`bun build --compile`), Eclipse Temurin JDK 21, Docker Compose.

## Global Constraints

- The compiled Bun binary is **glibc-linked** — runtime base must be glibc (Ubuntu/Debian), never musl/Alpine.
- Runtime image must contain **JDK 21** (`eclipse-temurin:21-jdk-jammy`).
- Image runs under existing hardening: read-only root FS, tmpfs `/tmp`, `cap_drop: ALL`, `no-new-privileges`, non-root user.
- Runtime user is `app`, uid `1000`, home `/home/app`; `HOME=/home/app` so Gradle's default `$HOME/.gradle` cache aligns with the mounted cache volume.
- Application source (`src/`) and tests are NOT changed — packaging only.
- `bun` is available on PATH in the implementation shell; **Docker is not** (no daemon). The full `docker build` is a manual follow-up; local verification uses `bun build --compile` directly.

---

## File-by-file impact

- **Rewrite** `Dockerfile` — two-stage: builder compiles, runtime ships binary + JDK.
- **Modify** `docker-compose.yml:16` — Gradle-cache volume path `/home/bun/.gradle` → `/home/app/.gradle`.
- **Modify** `.gitignore` — ignore the locally-produced `/gradle-mcp` binary so a dev (or this plan's smoke test) cannot accidentally commit it.
- README.md and CLAUDE.md need **no** change: both only reference `docker compose up --build`, which still works.

---

## Task 1: Two-stage compile-based image

This is a single coherent packaging change: the Dockerfile rewrite and the compose volume-path edit must land together because the compose path depends on the Dockerfile's `HOME`. Verified by compiling the exact builder command locally and smoke-running the produced binary.

**Files:**
- Rewrite: `Dockerfile`
- Modify: `docker-compose.yml` (line 16, the `gradle-cache` volume mount)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `package.json`, `bun.lock`, `src/` (entry point `src/server.ts`); the server reads `PROJECT_DIR` (required) and `PORT` (default 3000) from the environment and logs `gradle-mcp listening on :<PORT> for project <dir>` on startup.
- Produces: a runnable image whose `CMD` is the compiled `/app/gradle-mcp` binary running as uid 1000.

- [ ] **Step 1: Ignore the locally-built binary**

Append a line to `.gitignore` so a stray local compile is never committed. After editing, the file's relevant tail should contain:

```gitignore
.devenv
node_modules
/gradle-mcp
```

(Keep any existing entries; just add the `/gradle-mcp` line if absent.)

- [ ] **Step 2: Rewrite the `Dockerfile`**

Replace the entire contents of `Dockerfile` with:

```dockerfile
# --- Builder: compile the server to a standalone binary with Bun. ---
FROM oven/bun:1-debian AS builder
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
# Bundles @modelcontextprotocol/sdk + zod + the Bun runtime into one executable.
RUN bun build --compile --minify --sourcemap ./src/server.ts --outfile gradle-mcp

# --- Runtime: JDK only (Gradle needs a JVM); no Bun, no node_modules, no source. ---
FROM eclipse-temurin:21-jdk-jammy
# Temurin ships no non-root user; create one. Home backs Gradle's $HOME/.gradle cache.
RUN useradd --create-home --uid 1000 app
WORKDIR /app
COPY --from=builder --chown=app:app /build/gradle-mcp ./gradle-mcp
USER app
ENV HOME=/home/app PORT=3000
EXPOSE 3000
CMD ["./gradle-mcp"]
```

- [ ] **Step 3: Update the Gradle-cache volume path in `docker-compose.yml`**

Change the mount on line 16 from the old Bun-user home to the new `app` home. The `volumes:` block under the `gradle-mcp` service must read:

```yaml
    volumes:
      - ./your-gradle-project:/project:rw      # the mounted project
      - gradle-cache:/home/app/.gradle         # persist Gradle caches
```

Leave every other line of `docker-compose.yml` unchanged (ports, environment, `read_only`, `tmpfs`, `cap_drop`, `security_opt`, `pids_limit`, `mem_limit`, `cpus`, the commented `JAVA_OPTS`).

- [ ] **Step 4: Verify the compile command produces a working binary (locally, no Docker)**

This runs the *exact* command the builder stage uses and proves the compiled binary boots the full server (if any dependency failed to bundle, the binary would crash on import before logging the listening line). Use a scratch path so nothing lands in the repo.

First compile:

Run: `bun build --compile --minify --sourcemap ./src/server.ts --outfile /tmp/gmcp-smoke`
Expected: completes with no error and prints a bundle summary; `/tmp/gmcp-smoke` exists and is executable.

Then start the binary **in the background** (use the Bash tool's `run_in_background: true`):

Run: `PROJECT_DIR="$PWD" PORT=3399 /tmp/gmcp-smoke`
Expected (in the background task's output): `gradle-mcp listening on :3399 for project <repo path>`

Then, in a separate foreground command, hit the endpoint (curl retries until the port is up, so no sleep is needed):

Run:
```bash
curl -sS --retry 15 --retry-connrefused --retry-delay 1 \
  -o /tmp/gmcp-resp.txt -w '%{http_code}\n' \
  http://127.0.0.1:3399/ \
  -X POST \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```
Expected: prints `200`; `/tmp/gmcp-resp.txt` contains a JSON-RPC response envelope with a `result` carrying `serverInfo` (name `gradle-mcp`). This confirms the compiled binary runs the MCP HTTP stack end to end.

- [ ] **Step 5: Stop the smoke server and clean up the scratch binary**

Stop the background server task (Bash tool kill / TaskStop), then:

Run: `rm -f /tmp/gmcp-smoke /tmp/gmcp-resp.txt`
Expected: no output. Confirm the repo is clean of the binary:

Run: `git status --porcelain | grep -E 'gradle-mcp$' || echo CLEAN`
Expected: `CLEAN` (the `/gradle-mcp` binary, if it had been built in-repo, is gitignored anyway).

- [ ] **Step 6: Consistency + regression checks**

Confirm the Dockerfile `HOME` and the compose cache path agree, and no stale `/home/bun` remains in shipping files:

Run: `grep -n 'home/app' Dockerfile docker-compose.yml; grep -rn 'home/bun' Dockerfile docker-compose.yml || echo "no stale home/bun"`
Expected: `HOME=/home/app` shows in the Dockerfile, `/home/app/.gradle` shows in compose, and `no stale home/bun` prints.

Confirm the source change is packaging-only (the app is untouched, so the suite stays green):

Run: `bun test && bun run typecheck`
Expected: 25 pass / 3 skip / 0 fail; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docker-compose.yml .gitignore
git commit -m "build: compile server to standalone binary in multi-stage Docker image"
```

- [ ] **Step 8: Record the Docker-build follow-up**

Docker is unavailable in this environment, so the full image build could not be exercised here. Note for the user (do not block): in a Docker-capable environment, run `docker compose build` then `docker compose up`, and confirm (a) the build succeeds, (b) `tools/list` over `http://127.0.0.1:3000/` returns the three tools, and (c) `docker compose exec gradle-mcp java -version` reports JDK 21.

---

## Self-review notes

- **Spec coverage:** builder stage (Step 2), runtime stage + `app`/uid-1000/`/home/app` + `HOME` (Step 2), `--compile --minify --sourcemap` flags (Steps 2 & 4), compose volume path move (Step 3), glibc/JDK-21 constraints (Global Constraints + Step 2 base images), "packaging only / dev unchanged / .dockerignore unchanged" (Global Constraints + file-impact note). Every spec section maps to a step.
- **Verification honesty:** the spec's verification lists `docker compose build/up`, `tools/list`, and `java -version`. Docker is not runnable here, so Steps 4–6 verify the highest-risk part (the compile command yields a working server binary) locally, and Step 8 records the Docker-level checks verbatim as a user follow-up rather than silently dropping them.
- **No placeholders:** every step has concrete file contents or exact commands with expected output.
- **Consistency:** `HOME=/home/app` (Dockerfile) ↔ `/home/app/.gradle` (compose) ↔ uid 1000 are identical across Steps 2, 3, and 6.
