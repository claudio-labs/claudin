---
name: Devin wire A/B procedure — capture official chisel + Claudin side-by-side via mitmproxy
description: Exact reproducible steps to MITM-capture the official `devin` CLI and Claudin's GetChatMessage requests at the same time and proto-diff them. Use this whenever re-checking what the official client sends vs Claudin (f31, headers, model UID, metadata fields). Scripts live in scripts/profile/devin-re/.
type: reference
---

End-to-end procedure used 2026-06-12 to prove f31 is not enforced and that
the SWE-1.6 UI label maps to `swe-1-6-fast`. Repeat this when the official
client version bumps or to re-verify a wire diff. Tools confirmed present on
this box: `/usr/bin/mitmdump`, official CLI `~/.local/bin/devin`
(v2026.5.26-8), `claudindev`, repo scripts.

## Files
- `scripts/profile/devin-repro.ts` — Claudin-side sender (drives the exact
  chat.ts → buildGetChatMessageRequest → curlFetch → GetChatMessage path).
  Flags: `+sys +tools` (synthetic), `+real file=/tmp/devin_tools.json`
  (real 28 tool defs), `names=A,B`, `slice=a:b`. Arg1 = model UID.
- `scripts/profile/devin-re/dump.py` — mitmdump addon; on each GetChatMessage
  request writes `cap/reqN.headers` (Authorization REDACTED to scheme/len/
  prefix-shape) + `cap/reqN.body` (raw connect frame).
- `scripts/profile/devin-re/scan.mjs` — unframe (5-byte connect prefix +
  gunzip if flag bit 0) then list TOP-LEVEL proto field tags/wire/lengths.
- `scripts/profile/devin-re/scan2.mjs` — same, but descends into metadata
  (field 1) sub-fields and prints model UID (field 21). Checks metadata.f31.
  Prints structure only, never values (avoids leaking the api_key in
  metadata.f3 / the token).

## Steps
```bash
# 0. workdir + CA bundle (rustls/curl read SSL_CERT_FILE; curl also CURL_CA_BUNDLE)
mkdir -p /tmp/devin-diff
cat /etc/ssl/certs/ca-certificates.crt ~/.mitmproxy/mitmproxy-ca-cert.pem > /tmp/devin-diff/ca-bundle.pem

# 1. start capture (background)
mitmdump --listen-host 127.0.0.1 --listen-port 8888 -w /tmp/devin-diff/flows.mitm -q &

# 2. OFFICIAL devin through the proxy (-p = non-interactive; uses configured model = SWE-1.6 → swe-1-6-fast)
env HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 \
    SSL_CERT_FILE=/tmp/devin-diff/ca-bundle.pem CURL_CA_BUNDLE=/tmp/devin-diff/ca-bundle.pem \
    NODE_EXTRA_CA_CERTS=/tmp/devin-diff/ca-bundle.pem REQUESTS_CA_BUNDLE=/tmp/devin-diff/ca-bundle.pem \
    ~/.local/bin/devin -p "oi" --permission-mode auto

# 3. CLAUDIN through the SAME proxy (curlFetch inherits env → uses the proxy + CA).
#    Use swe-1-6-fast (swe-1-6 → opaque "internal error"). +real mirrors a real turn.
env HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 \
    SSL_CERT_FILE=/tmp/devin-diff/ca-bundle.pem CURL_CA_BUNDLE=/tmp/devin-diff/ca-bundle.pem \
    DEVIN_DEBUG_DUMP_REQ=1 \
    bun --preload ./src/stubs/test-preload.ts scripts/profile/devin-repro.ts swe-1-6-fast \
        +sys +tools +real file=/tmp/devin_tools.json

# 4. extract both requests offline (system python can't import mitmproxy; use mitmdump -nr)
cd /tmp/devin-diff && mitmdump -nr flows.mitm -s <repo>/scripts/profile/devin-re/dump.py -q

# 5. decode + diff
node <repo>/scripts/profile/devin-re/scan.mjs  cap/req1.body "OFFICIAL"
node <repo>/scripts/profile/devin-re/scan2.mjs cap/req1.body "OFFICIAL"   # metadata sub-fields + model UID
node <repo>/scripts/profile/devin-re/scan2.mjs cap/req3.body "CLAUDIN"

# 6. CLEAN UP — flows.mitm + cap/*.body contain the session token
#    (metadata.f3 = devin-session-token$<jwt>) and full Authorization headers.
rm -f /tmp/devin-diff/flows.mitm /tmp/devin-diff/ca-bundle.pem /tmp/devin-diff/cap/*.body
# stop the proxy:
pkill -f 'mitmdump --listen-host 127.0.0.1 --listen-port 8888'
```

## Identifying which flow is which (no UA needed)
- Official = HTTP/1.1, NO connect gzip, has `sentry-trace` header (value ==
  the trace ID in the CLI's error), Authorization len ~385 (mints a long
  user_jwt), metadata 981 bytes WITH metadata.f31 (732 hex).
- Claudin = HTTP/2, `connect-content-encoding: gzip`, UA
  `chisel/2026.5.26-5` (hardcoded DEVIN_USER_AGENT — official is -8),
  Authorization len ~195 (persistent token sent directly), metadata 245
  bytes, NO f31.
- Match the official GetChatMessage by `sentry-trace` == the error's trace ID.

## What the 2026-06-12 run proved
metadata sub-fields 1,2,3,4,5,7,12 byte-identical; only diff = official's
metadata.f31 (Claudin omits). Claudin (no f31) + swe-1-6-fast → same
`Reached message rate limit` as official → f31 NOT enforced. swe-1-6 → opaque
error (wrong UID). Full conclusions in devin-port-works-quota-blocker.md.
