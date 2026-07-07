# Egress Allowlist Example (Squid Proxy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained Docker Compose example that restricts the `gradle-mcp` container's network egress to an explicit allowlist of domains, enforced by a Squid proxy on a network-level default-deny topology.

**Architecture:** Two-service Compose. `gradle-mcp` sits on an `internal: true` Docker network with no route to the internet; its only outbound path is the JVM proxy pointed at a `squid` sidecar. Squid is attached to both the internal network and a normal `egress` bridge, and enforces a `dstdomain` allowlist with a deny-all default — so denied domains get a 403 and, even if a build ignores the proxy env, it has no network route off the internal net.

**Tech Stack:** Docker Compose, Squid (`ubuntu/squid` image), the existing Bun-compiled `gradle-mcp` container (`Dockerfile`).

## Global Constraints

- **No TLS interception / no CA cert.** Squid tunnels `CONNECT` without decrypting; allowed hosts stay end-to-end TLS. Do not inject any CA into the JVM truststore.
- **Additive only.** Do not modify the existing `docker-compose.yml`. All new files are additive.
- **Default-deny.** Squid config must end with `http_access deny all`; the allowlist is the only thing that opens egress.
- **Reuse the main compose hardening block verbatim** for the `gradle-mcp` service: `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `pids_limit: 512`, `mem_limit: 4g`, `cpus: "2.0"`, the `gradle-cache` volume, and the loopback-bound `127.0.0.1:3000:3000` port.
- **Pin the Squid image tag** (e.g. `ubuntu/squid:6.6-24.04_edge` or the current stable tag) — never `latest` — so the example is reproducible.
- **Docker is NOT available in the devcontainer.** Static validation (YAML/`docker compose config`) and the end-to-end egress tests must be run on a Docker host outside this devcontainer. Where a step needs Docker, it is marked **[Docker host]**.

## File Structure

| File | Responsibility |
|------|----------------|
| `squid/squid.conf` | Squid default-deny allowlist policy. Reads allowed domains from `allowlist.txt`. |
| `squid/allowlist.txt` | Editable list of permitted domains, one per line, with Gradle defaults. |
| `docker-compose.egress-allowlist.yml` | The two services (`gradle-mcp`, `squid`) + two networks (`internal`, `egress`). |
| `README.md` | New "Egress allowlist example" section: run command, how to edit the allowlist, security rationale. |

---

### Task 1: Squid allowlist config

**Files:**
- Create: `squid/squid.conf`
- Create: `squid/allowlist.txt`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `squid/squid.conf` listening on `http_port 3128`, reading domains from `/etc/squid/allowlist.txt`. Later tasks mount these two files read-only into the Squid container at `/etc/squid/squid.conf` and `/etc/squid/allowlist.txt`.

- [ ] **Step 1: Write `squid/allowlist.txt`**

```text
# Domains gradle-mcp is allowed to reach. One per line.
# A leading dot matches the domain AND all its subdomains
# (e.g. .gradle.org covers services.gradle.org, plugins.gradle.org).
# A bare domain matches only that exact host.
# Edit this list to match what YOUR build actually needs, then restart the proxy.

.gradle.org            # Gradle distributions, plugin portal, plugin artifacts
.maven.apache.org      # Maven Central (repo.maven.apache.org)
repo1.maven.org        # Maven Central (alternate host)
dl.google.com          # Google's Maven repo (Android / AndroidX)
```

- [ ] **Step 2: Write `squid/squid.conf`**

```squid
# Egress allowlist for gradle-mcp. Default-deny: only domains listed in
# allowlist.txt may be reached; everything else gets a 403.

# Allowed destination domains, read from a separate editable file.
acl allowed dstdomain "/etc/squid/allowlist.txt"

# Only permit CONNECT tunnels to the standard HTTPS port.
acl SSL_ports port 443
acl CONNECT method CONNECT
http_access deny CONNECT !SSL_ports

# Allow only allowlisted domains; deny everything else (default-deny).
http_access allow allowed
http_access deny all

# Pure forwarding gateway — no on-disk cache.
cache deny all

# Surface allow/deny decisions in `docker compose logs squid`.
access_log stdio:/dev/stdout

http_port 3128
```

- [ ] **Step 3: Sanity-check the files statically (no Docker)**

Run:
```bash
test -s squid/squid.conf && test -s squid/allowlist.txt && \
grep -q 'http_access deny all' squid/squid.conf && \
grep -q 'http_port 3128' squid/squid.conf && \
grep -q 'dstdomain "/etc/squid/allowlist.txt"' squid/squid.conf && \
echo OK
```
Expected: `OK` (files exist, are non-empty, and contain the default-deny rule, the listen port, and the allowlist reference).

- [ ] **Step 4: Validate Squid parses the config [Docker host]**

Run (on a machine with Docker; uses the pinned image and Squid's own parser):
```bash
docker run --rm \
  -v "$PWD/squid/squid.conf:/etc/squid/squid.conf:ro" \
  -v "$PWD/squid/allowlist.txt:/etc/squid/allowlist.txt:ro" \
  ubuntu/squid:6.6-24.04_edge squid -k parse -f /etc/squid/squid.conf
```
Expected: Squid prints its config-parse output and exits 0 with no `FATAL`/`ERROR` lines. (If the pinned tag differs, use the tag chosen in Task 2 — keep them identical.)

- [ ] **Step 5: Commit**

```bash
git add squid/squid.conf squid/allowlist.txt
git commit -m "feat: add Squid default-deny allowlist config for egress example"
```

---

### Task 2: Compose file with network isolation

**Files:**
- Create: `docker-compose.egress-allowlist.yml`
- Reference (do not modify): `docker-compose.yml` (copy the hardening block from here)

**Interfaces:**
- Consumes: `squid/squid.conf` and `squid/allowlist.txt` from Task 1 (mounted read-only into the `squid` service).
- Produces: a runnable Compose project exposing the MCP endpoint on `127.0.0.1:3000`, with `gradle-mcp` reachable-outbound only through `squid:3128`.

- [ ] **Step 1: Write `docker-compose.egress-allowlist.yml`**

```yaml
# Egress-restricted variant of docker-compose.yml.
#
# gradle-mcp runs on an INTERNAL Docker network with no route to the internet.
# Its only way out is the JVM proxy pointed at the `squid` sidecar, which
# enforces a domain allowlist (see squid/allowlist.txt) and denies everything
# else. Even a build that ignores the proxy env has no network route off the
# internal net.
#
# Usage:
#   1. Point the ./your-gradle-project volume at your project (below).
#   2. Edit squid/allowlist.txt to match what your build needs.
#   3. docker compose -f docker-compose.egress-allowlist.yml up --build
services:
  gradle-mcp:
    build: .
    ports:
      - "127.0.0.1:3000:3000"   # bind to loopback only; rely on network isolation
    environment:
      PROJECT_DIR: /project
      PORT: "3000"
      GRADLE_TIMEOUT_MS: "600000"
      DEFAULT_OUTPUT_LINES: "500"
      MAX_OUTPUT_LINES: "5000"
      # Route all JVM HTTP(S) traffic through the allowlisting Squid proxy.
      JAVA_OPTS: >-
        -Dhttp.proxyHost=squid -Dhttp.proxyPort=3128
        -Dhttps.proxyHost=squid -Dhttps.proxyPort=3128
    volumes:
      - ./your-gradle-project:/project:rw      # the mounted project
      - gradle-cache:/home/app/.gradle         # persist Gradle caches
    depends_on:
      - squid
    networks:
      - internal
    # --- hardening (identical to docker-compose.yml) ---
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 512
    mem_limit: 4g
    cpus: "2.0"

  squid:
    image: ubuntu/squid:6.6-24.04_edge
    volumes:
      - ./squid/squid.conf:/etc/squid/squid.conf:ro
      - ./squid/allowlist.txt:/etc/squid/allowlist.txt:ro
    networks:
      - internal   # reachable by gradle-mcp
      - egress     # the only path to the internet

networks:
  internal:
    internal: true   # no gateway to the outside world
  egress: {}

volumes:
  gradle-cache:
```

- [ ] **Step 2: Validate the Compose file parses [Docker host]**

Run:
```bash
docker compose -f docker-compose.egress-allowlist.yml config >/dev/null && echo OK
```
Expected: `OK` (Compose resolves the file with no errors; prints the fully-expanded config to stdout, discarded here).

- [ ] **Step 3: Static YAML sanity-check (no Docker)**

Run (inside the devenv shell — Bun can parse YAML via a one-liner, or use `python3` if present):
```bash
devenv shell -- bun -e "import {readFileSync} from 'fs'; const y=readFileSync('docker-compose.egress-allowlist.yml','utf8'); if(!y.includes('internal: true')) throw new Error('missing internal:true'); if(!y.includes('proxyHost=squid')) throw new Error('missing proxy env'); console.log('OK')"
```
Expected: `OK` (asserts the two load-bearing lines exist: the internal network flag and the JVM proxy env).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.egress-allowlist.yml
git commit -m "feat: add egress-allowlist compose (internal net + Squid sidecar)"
```

---

### Task 3: README section

**Files:**
- Modify: `README.md` (add a new section after the existing "Run" section)

**Interfaces:**
- Consumes: the files from Tasks 1–2 (references their paths and the run command).
- Produces: user-facing docs. No downstream consumers.

- [ ] **Step 1: Add the "Egress allowlist example" section to `README.md`**

Insert this block immediately after the existing ```` ``` ```` that closes the "## Run" section's code block (before "## Connecting an agent"):

```markdown
## Egress allowlist example

`docker-compose.yml` leaves network egress open. To restrict a build to a fixed
set of domains, use the egress-allowlist variant instead. It runs `gradle-mcp`
on an **internal** Docker network with no internet route and forces all traffic
through a [Squid](http://www.squid-cache.org/) proxy that enforces a domain
allowlist (default-deny). Denied domains get a `403`; a build that ignores the
proxy env still has no route off the internal network.

No TLS interception happens — connections stay end-to-end encrypted, and no CA
cert is added to the JVM. Only the *destination domain* is checked.

```bash
# 1. Point the ./your-gradle-project volume at your project (edit the compose file).
# 2. Edit squid/allowlist.txt to list the domains your build needs.
# 3. Run:
docker compose -f docker-compose.egress-allowlist.yml up --build
```

The MCP endpoint is at `http://127.0.0.1:3000/` as usual. Edit
[`squid/allowlist.txt`](squid/allowlist.txt) (one domain per line; a leading dot
matches subdomains) and restart to change what's reachable. Blocked and allowed
requests are visible in `docker compose -f docker-compose.egress-allowlist.yml logs squid`.
```

- [ ] **Step 2: Verify the section renders and links resolve (no Docker)**

Run:
```bash
grep -q '## Egress allowlist example' README.md && \
grep -q 'docker-compose.egress-allowlist.yml up --build' README.md && \
grep -q 'squid/allowlist.txt' README.md && echo OK
```
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the egress allowlist example in README"
```

---

### Task 4: End-to-end egress verification

**Files:**
- No new files. This task exercises the artifacts from Tasks 1–3 and, if needed, applies the port-publishing fallback to `docker-compose.egress-allowlist.yml`.

**Interfaces:**
- Consumes: the full Compose project from Tasks 1–3.
- Produces: verified behavior (allowed egress works, denied egress blocked, no direct route, host reachability). May modify `docker-compose.egress-allowlist.yml` if the fallback in Step 5 is triggered.

> **All steps require a Docker host.** They cannot run inside this devcontainer. Point `./your-gradle-project` at any small Gradle project first (or use the repo's `tests/fixtures` Gradle project if suitable).

- [ ] **Step 1: Bring the stack up [Docker host]**

Run:
```bash
docker compose -f docker-compose.egress-allowlist.yml up --build -d
docker compose -f docker-compose.egress-allowlist.yml ps
```
Expected: both `gradle-mcp` and `squid` are `running`/healthy.

- [ ] **Step 2: Allowed egress succeeds [Docker host]**

From inside the `gradle-mcp` container, reach an allowlisted host through the proxy:
```bash
docker compose -f docker-compose.egress-allowlist.yml exec gradle-mcp \
  sh -c 'java -version; \
    curl -sS -o /dev/null -w "%{http_code}\n" \
      -x http://squid:3128 https://repo.maven.apache.org/maven2/ || true'
```
Expected: an HTTP status (e.g. `200`/`301`) — the request completes through Squid. (If `curl` is absent in the runtime image, instead run a real dependency-resolving task via the MCP endpoint and confirm it downloads from Maven Central.)

- [ ] **Step 3: Denied egress is blocked [Docker host]**

Attempt a host that is NOT on the allowlist:
```bash
docker compose -f docker-compose.egress-allowlist.yml exec gradle-mcp \
  sh -c 'curl -sS -o /dev/null -w "%{http_code}\n" \
      -x http://squid:3128 https://example.com/ || echo "refused"'
docker compose -f docker-compose.egress-allowlist.yml logs squid | tail -5
```
Expected: the request is denied — a `403` status code, and the Squid log shows a `TCP_DENIED`/`403` entry for `example.com`.

- [ ] **Step 4: No direct route off the internal network [Docker host]**

Bypass the proxy entirely and confirm there is no route:
```bash
docker compose -f docker-compose.egress-allowlist.yml exec gradle-mcp \
  sh -c 'curl -sS --max-time 5 -o /dev/null -w "%{http_code}\n" https://example.com/ || echo "no route (expected)"'
```
Expected: the connection fails/times out (`no route (expected)`), proving egress control is enforced at the network layer, not just the JVM proxy setting.

- [ ] **Step 5: Host can reach the MCP endpoint (with fallback) [Docker host]**

Run:
```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/ || echo "UNREACHABLE"
```
Expected: a response from the MCP server (any HTTP status), confirming the published port works while `gradle-mcp` is on an `internal` network.

**If `UNREACHABLE`** (Docker refused to publish the port from an internal-only network): add a second internal network for the host-facing port and re-run Steps 1 and 5.
- In `networks:` add:
  ```yaml
    frontend:
      internal: true
  ```
- Add `frontend` to the `gradle-mcp` service's `networks:` list (so it has `internal` and `frontend`). Both are `internal: true`, so egress stays impossible.
- Re-run Step 1 (`up`) and Step 5; expect a valid HTTP status.

- [ ] **Step 6: Tear down and commit any fallback change [Docker host]**

```bash
docker compose -f docker-compose.egress-allowlist.yml down
# Only if Step 5 triggered the fallback edit:
git add docker-compose.egress-allowlist.yml && \
  git commit -m "fix: add internal frontend network so the MCP port publishes"
```
Expected: stack stops cleanly; a commit exists only if the fallback was needed.

---

## Self-Review

**1. Spec coverage:**
- Two-network isolation (`internal` + `egress`) → Task 2. ✓
- `gradle-mcp` on internal only, `JAVA_OPTS` proxy, no CA → Task 2. ✓
- Squid `dstdomain` allowlist, default-deny, CONNECT→443, `cache deny all`, stdout log → Task 1. ✓
- `squid/allowlist.txt` with Gradle defaults + edit comment → Task 1. ✓
- `docker-compose.egress-allowlist.yml` name + `squid/` subdir → Tasks 1, 2. ✓
- README section (run, edit allowlist, rationale) → Task 3. ✓
- Verification: allowed works, denied blocked, no direct route, host reachability + fallback → Task 4. ✓
- Pinned Squid tag → Global Constraints + Tasks 1–2. ✓
- Reuse hardening block verbatim → Global Constraints + Task 2. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". Every code/config step shows full content. The only conditional ("if UNREACHABLE") is the spec's explicit documented fallback with exact edits. ✓

**3. Type consistency:** Proxy host/port (`squid:3128`) matches `http_port 3128`. Mount paths (`/etc/squid/squid.conf`, `/etc/squid/allowlist.txt`) match the `dstdomain "/etc/squid/allowlist.txt"` reference. The pinned image tag `ubuntu/squid:6.6-24.04_edge` is used identically in Task 1 Step 4 and Task 2. ✓
