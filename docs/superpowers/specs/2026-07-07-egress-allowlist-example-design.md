# Egress allowlist example (Squid proxy) — design

**Date:** 2026-07-07
**Status:** Approved, ready for implementation plan

## Goal

Ship a self-contained, copy-and-run Docker Compose example that restricts the
`gradle-mcp` container's network egress to an explicit **allowlist of domains**.
Today [docker-compose.yml](../../../docker-compose.yml) only *hints* at this via a
commented `JAVA_OPTS` line pointing at "an allowlisting proxy". This example makes
that concrete and enforceable.

The threat it addresses: Gradle builds run arbitrary code by design. Even with the
container hardening already in place (non-root, read-only FS, `cap_drop: ALL`,
`no-new-privileges`, resource limits, timeout), a malicious or compromised build can
still exfiltrate data or pull payloads over the network. This example removes that by
making the network itself default-deny.

## Non-goals

- **TLS interception / content inspection.** We filter on the destination domain from
  the `CONNECT` request; connections stay end-to-end encrypted. No CA cert is injected
  into the JVM truststore. (A build's HTTPS payloads are not decrypted or inspected —
  only *where* it connects is controlled.)
- **Replacing the main compose file.** This is an additive example, not a change to the
  default `docker-compose.yml`.
- **Per-path / per-URL rules.** Allowlisting is by domain only.

## Why Squid (and not mitmproxy / `--allow-hosts`)

`mitmproxy`'s `--allow-hosts` / `--ignore-hosts` flags control **TLS interception**
(which hosts get decrypted vs. forwarded untouched), **not access**. Non-matching hosts
are forwarded *unblocked*, so those flags cannot implement an egress allowlist. There is
no native "allow these, deny the rest" flag in mitmproxy
([mitmproxy#3295](https://github.com/mitmproxy/mitmproxy/issues/3295),
[#818](https://github.com/mitmproxy/mitmproxy/issues/818)). Blocking would require a
custom addon.

Squid is purpose-built for exactly this: `dstdomain` ACLs with proper subdomain
matching, an explicit deny-all default, and clean `CONNECT` handling — all via
declarative config, no scripting. It is the industry-standard tool for egress
allowlists and is hard to misconfigure into an accidental allow-all.

## Architecture

Network-level default-deny with Squid as the only route out:

```
   host :3000 ── gradle-mcp ─────────────── squid ──────────────── internet
                 (internal net only,          dstdomain allowlist,
                  no internet route)          deny-all default, 403s the rest
```

### Networks

- **`internal`** — `internal: true`. Carries `gradle-mcp` <-> `squid` traffic. Docker
  gives this network no gateway/NAT, so any container attached *only* here cannot reach
  the internet.
- **`egress`** — a normal bridge network. Attached to `squid` only. This is the sole
  path to the outside world.

`gradle-mcp` is attached **only** to `internal`. `squid` is attached to **both**. The
consequence: even if a build ignores the JVM proxy settings entirely, it physically has
no route off the `internal` network — the allowlist cannot be bypassed at the
application layer.

### `gradle-mcp` service

- Reuses `build: .` and the exact hardening block from the main compose (`read_only`,
  `tmpfs: /tmp`, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`, `mem_limit`,
  `cpus`, the `gradle-cache` volume, and the loopback-bound `127.0.0.1:3000:3000` port).
- Adds `JAVA_OPTS` so the JVM routes HTTP and HTTPS through Squid:
  ```
  JAVA_OPTS: >-
    -Dhttp.proxyHost=squid -Dhttp.proxyPort=3128
    -Dhttps.proxyHost=squid -Dhttps.proxyPort=3128
  ```
- Attached to the `internal` network only. `depends_on: [squid]`.
- **No CA cert.** Squid tunnels `CONNECT` without decrypting; allowed hosts stay
  end-to-end TLS.

### `squid` service

- Image: `ubuntu/squid` (Canonical, actively maintained), pinned to a specific tag.
- Config mounted read-only: `./squid/squid.conf:/etc/squid/squid.conf:ro` and
  `./squid/allowlist.txt:/etc/squid/allowlist.txt:ro`.
- Attached to both `internal` and `egress`.
- Pure forwarder: `cache deny all` (no on-disk cache), access log to stdout so allow/
  deny decisions are visible in `docker compose logs`.

## Config files

### `squid/squid.conf`

Minimal, default-deny:

```squid
# Allowed destination domains are read from a separate file (one per line).
acl allowed dstdomain "/etc/squid/allowlist.txt"

# Only permit CONNECT tunnels to the standard HTTPS port.
acl SSL_ports port 443
acl CONNECT method CONNECT
http_access deny CONNECT !SSL_ports

# Allow only allowlisted domains; deny everything else.
http_access allow allowed
http_access deny all

# Pure forwarding gateway — no caching.
cache deny all

# Surface allow/deny decisions in `docker compose logs`.
access_log stdio:/dev/stdout
http_port 3128
```

Notes:
- `http_access` rules are evaluated top-to-bottom; first match wins. `http_access deny
  all` as the final rule makes the policy default-deny.
- Squid applies `dstdomain` matching to both plain HTTP requests (from the `Host` /
  request URL) and `CONNECT` requests (from the tunnel target), so both are covered.
- The client source is intentionally unrestricted (no `localnet` ACL) — the `internal`
  network already guarantees only `gradle-mcp` can reach Squid.

### `squid/allowlist.txt`

One domain per line; a leading dot matches the domain and all subdomains. Ships with
sensible Gradle defaults and a clear "edit this" comment:

```
# Domains gradle-mcp is allowed to reach. One per line.
# A leading dot matches all subdomains (e.g. .gradle.org covers services.gradle.org).
# Edit this list to match what YOUR build actually needs, then restart the proxy.

.gradle.org            # Gradle distributions, plugin portal, plugin artifacts
.maven.apache.org      # Maven Central (repo.maven.apache.org)
repo1.maven.org        # Maven Central (alternate host)
dl.google.com          # Google's Maven repo (Android / AndroidX)
```

## Files added

| File | Purpose |
|------|---------|
| `docker-compose.egress-allowlist.yml` (repo root) | The two services + two networks. |
| `squid/squid.conf` | Squid default-deny allowlist config. |
| `squid/allowlist.txt` | Editable list of permitted domains. |
| `README.md` (new section) | How to run, how to edit the allowlist, security rationale. |

## Usage (documented in README)

```bash
# 1. Point the project volume at your Gradle project (edit the compose file).
# 2. Edit squid/allowlist.txt to match what your build needs.
# 3. Run:
docker compose -f docker-compose.egress-allowlist.yml up --build
```

The MCP endpoint is at `http://127.0.0.1:3000/` as usual. When a build tries to reach a
domain that isn't allowlisted, Squid returns `403 Forbidden` and the fetch fails; the
denial is visible in `docker compose logs squid`.

## Verification

1. **Allowed egress works** — a build that resolves dependencies from Maven Central /
   the Gradle plugin portal succeeds through the proxy.
2. **Denied egress is blocked** — an attempt to reach a non-allowlisted domain (e.g. a
   quick `CONNECT example.com:443` from inside the `gradle-mcp` container, or a build
   step pointed at an off-list repo) is refused with a Squid 403, logged to stdout.
3. **No direct route** — from inside `gradle-mcp`, a direct connection to an external
   host *without* the proxy fails (no network route), confirming enforcement is at the
   network layer, not just the JVM proxy setting.
4. **Host reachability** — confirm the host can still reach `http://127.0.0.1:3000/`
   with `gradle-mcp` on the `internal` network. If Docker refuses to publish the port
   from an `internal`-only network, attach a second `internal: true` network to
   `gradle-mcp` for the published port (this preserves zero egress) and re-verify.

## Risks / open questions

- **Port publishing on an internal network** — expected to work (host<->container DNAT
  is independent of the network's outbound isolation), but explicitly verified above
  with a documented fallback.
- **Allowlist drift** — real builds may need more domains (e.g. company Artifactory,
  additional plugin CDNs). The defaults are documented as a starting point the user
  edits; this is expected, not a defect.
- **`ubuntu/squid` tag stability** — pin to a specific tag rather than `latest` so the
  example is reproducible.
