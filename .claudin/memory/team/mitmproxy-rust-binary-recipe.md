---
name: mitmproxy recipe that works against Rust agent CLIs
description: SSL_CERT_FILE + NODE_EXTRA_CA_CERTS + REQUESTS_CA_BUNDLE combined-bundle trick that successfully intercepts the Devin Rust binary's TLS traffic
type: reference
---

To intercept TLS from third-party agent CLIs (verified with Devin's Rust binary, `v2026.5.26-5`) without recompiling them:

```bash
# 1. Bundle system roots + mitmproxy CA (Rust rustls reads SSL_CERT_FILE)
cat /etc/ssl/certs/ca-certificates.crt ~/.mitmproxy/mitmproxy-ca-cert.pem > /tmp/ca-bundle.pem

# 2. Start mitmdump recording flows
mitmdump --listen-host 127.0.0.1 --listen-port 8888 -w /tmp/flows.mitm &

# 3. In the target shell, set ALL of these — different stacks read different envs
export HTTPS_PROXY=http://127.0.0.1:8888
export HTTP_PROXY=http://127.0.0.1:8888
export SSL_CERT_FILE=/tmp/ca-bundle.pem        # rustls, OpenSSL via env
export NODE_EXTRA_CA_CERTS=/tmp/ca-bundle.pem  # Node sub-processes the binary may spawn
export REQUESTS_CA_BUNDLE=/tmp/ca-bundle.pem   # Python sub-processes / requests lib
```

The Devin binary respected `SSL_CERT_FILE` — full TLS visibility, no `--ssl-insecure`/`--insecure` flag needed on the binary side. If a future Rust CLI doesn't honour `SSL_CERT_FILE` (statically pinned roots), fall back to webpki-roots patching or socket-level capture.

**Why:** Used during the 2026-06-05 Devin CLI reverse-engineering session to confirm `server.codeium.com` is shared between Devin and Windsurf. The same recipe should work for any future RE of a Cognition/Codeium product, Codex CLI, or similar Rust+TLS agents.

**How to apply:** When the user asks to "see what X CLI is sending" or "reverse-engineer the wire format of X", reach for this recipe first. The bundle path can live anywhere; `/tmp/devin-re/mitm/ca-bundle.pem` is the one currently on disk from the Devin session.
