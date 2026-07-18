# Devin provider port — research archive (abandoned)

> **Status: abandoned (user decision, 2026-06-12).** The Devin CLI port is
> technically possible but not a sustainable target: Devin's chat tier is gated
> server-side by `metadata.f31`, a **per-request sealed client-attestation** the
> closed-source `chisel` Rust binary generates locally. It cannot be cached,
> replayed, or practically harvested, and reverse-engineering the embedded key
> rotates with every chisel release. This file consolidates the reverse-
> engineering notes (previously scattered across team memories) as a reference
> for any future attempt. The branch `feat/devin-provider` (`ec607be`) was pushed
> but never merged; its wire-format commits are reusable if Cognition ever ships
> a real API-key path for Devin chat.

The one still-live, generic memory is `mitmproxy-rust-binary-recipe.md` (TLS
interception recipe for Rust agent CLIs) — kept in team memory because it is not
Devin-specific.

## The f31 verdict (canonical) — and the contradiction it resolves

The f31 story reversed itself twice; this is the settled reading:

- **RETRACTED — "f31 is cosmetic" (2026-06-06):** an RE agent replayed captured
  chisel bodies with f31 mutated (empty, random, omitted, 128 KB) and every
  UTF-8-valid value returned HTTP 200, suggesting the server only validated
  UTF-8. This was a **mitm-replay artifact** — replaying a captured chisel body
  is not the same as Claudin originating the request.
- **RETRACTED — "the blocker is a rate limit, not f31" (2026-06-12 AM):** a run
  hit `Reached message rate limit` and that was read as "authenticated +
  accepted, just throttled." It was confounded by an actual rate-limit window.
- **CANONICAL — clean-window A/B (2026-06-12 PM):** re-run when the official CLI
  banner showed **Pro · 100% remaining**, so no rate limit was in play:
  - Official `devin -p "oi"` → **success** (both requests carry `metadata.f31`).
  - Claudin (repro, `swe-1-6-fast`, **no f31**, metadata otherwise byte-identical
    for sub-fields 1,2,3,4,5,7,12, same valid model UID) → `permission_denied:
    "an internal error occurred"`.
  - Transport is exonerated (Claudin's HTTP/2+gzip curl path is the same path
    that previously reached the rate-limiter, so the edge accepts it).
  - **The only structural metadata difference is f31.** With quota free, its
    absence flips success → opaque denial. So **f31 is the gate, not a rate
    limit.**

Residual caveat (why "re-implicated, not mathematically proven"): older notes
claimed Claudin completed ~30 no-f31 turns, but that was an inference — the only
decoded no-f31 captures are failing ones. A metadata sub-field *value* (not
length) could also differ (e.g. client version `-5` vs `-8`; `scan2.mjs` compares
lengths only). Fully proving it would need to inject a valid f31 (the sealed
366-byte blob from the closed binary) or capture a genuinely-succeeding no-f31
request. Neither is worth the effort given the decision to abandon.

## What f31 IS (from binary + strace RE, 2026-06-12)

RE'd on `~/.local/share/devin/cli/_versions/2026.5.26-8/bin/devin` (129 MB
static-PIE, stripped, Rust).

- **A sealed (encrypted-to-server) attestation blob, not a plain signature.**
  Fixed **366 bytes**, ~100% entropy per byte, no magic/version prefix → it is
  ciphertext (a readable signed payload would leave its bytes visible).
- **Content-bound:** replaying a byte-identical f31 from a 200 response →
  `permission_denied`. So the sealed plaintext includes a body hash and/or
  timestamp/nonce checked for freshness.
- **Per-request unique:** 4 captured requests (two byte-identical "oi" bodies,
  same size 62551) produced 4 distinct f31 values → carries fresh nonce/ephemeral
  key per call; cannot be cached or pre-generated.
- **Built in** `windsurf-api-client/src/translation.rs::create_metadata`
  (confirmed via tracing string paths in the binary); auth in `auth.rs`.
- **Inputs:** machine fingerprint = the MAC set (`ip -o addr show` +
  `/sys/class/net/<iface>/address`; no `/etc/machine-id`, no DMI serial); fresh
  randomness = `getrandom` 32 B ×6 per run. Crypto: **aws-lc-rs 1.16.2**
  (Ed25519, X25519, ChaCha20-Poly1305, AES-GCM, HKDF). Do not infer HPKE from
  `strings` alone — DHKEM/HPKE strings also come from rustls' ECH.
- **Key material is embedded in the binary**, not in `credentials.toml`.

Why it exists: anti-abuse / anti-third-party-client attestation binding
(machine identity × request × time), sealed so only Cognition's backend can open
it. A non-chisel client can't forge it without the embedded key **and** the exact
plaintext layout — hence the opaque denial when it is absent.

### Why every unblock route was rejected

- **Reuse/cache an f31** — impossible (per-request unique; replay rejected).
- **Sidecar-harvest** from a headless official binary — impractical: the official
  binary seals ITS body+nonce, which won't transfer to Claudin's body; Cognition
  can also kill headless mode in any release.
- **Static RE** of the embedded key/suite/layout — ~4–8 h in Ghidra (not
  installed here; r2 alone is swamped by 3.5 MB relocations and placeholder
  symbol names) AND it rotates every chisel release.

## Durable wire facts (still true; reusable if the port reopens)

These are correct and independent of the f31 gate — the `feat/devin-provider`
commits already implement them.

- **Shared backend.** Devin talks to the same `server.codeium.com` Connect-RPC
  backend as Windsurf (`.../GetChatMessage`), disambiguated by
  `extension_name="chisel"` (Windsurf sends `"windsurf"`), not by host. A
  Devin-Pro account gets 403 on the *Windsurf* preset because entitlement is
  gated on that identity field, not because of a UID/catalog bug.
- **OAuth exchange.** `POST https://api.devin.ai/auth/cli/token` with
  `{"code","code_verifier"}` → `{"token":"<HS256 JWT>"}`. **Not** the codeium
  `ExchangePKCEAuthorizationCode` endpoint (that 401s Devin-scoped codes). Tenant
  routing is fixed for SaaS Devin: apiServer `server.codeium.com`, webapp
  `app.devin.ai`, api `api.devin.ai`.
- **Token prefix.** The JWT must be stored/sent as `devin-session-token$<jwt>`
  for `server.codeium.com` Basic auth (also the value of `metadata.f3`).
- **Model UID.** Use `swe-1-6-fast` (the SWE-1.6 UI label maps to it); `swe-1-6`
  → opaque "internal error". UID values are tier-gated
  (`claude-sonnet-4-6-thinking` 403s where `-1m` and `swe-1-6-fast` pass).
- **Required GetChatMessage top-level fields** chisel always sends: `#1 metadata`,
  `#2 system_prompt`, `#3 chat_message_prompts`, `#7 request_type`, `#8
  completion_configuration`, `#10 tools`, `#15 conversation_context`, `#16
  cascade_id`, `#20 client_flag=1`, `#21 chat_model_uid`, `#22 prompt_id`.
- **Catalog.** Devin uses `GetCliTeamSettings` (entitlement-aware, returns only
  usable UIDs); Windsurf uses `GetCascadeModelConfigs` (its `disabled` field does
  NOT reflect per-account entitlement). Devin's own default model is
  `claude-opus-4-8-medium` (`~/.config/devin/config.json` `agent.model`).

## A/B capture procedure (mitmproxy)

Reproducible steps to capture the official `devin` CLI and Claudin's
GetChatMessage side-by-side and proto-diff them. Scripts live in
`scripts/profile/devin-re/` (`dump.py` mitmdump addon, `scan.mjs` top-level
fields, `scan2.mjs` metadata sub-fields + model UID — structure only, never
values, to avoid leaking the token). Also see `mitmproxy-rust-binary-recipe.md`.

```bash
# 0. workdir + CA bundle (rustls/curl read SSL_CERT_FILE; curl also CURL_CA_BUNDLE)
mkdir -p /tmp/devin-diff
cat /etc/ssl/certs/ca-certificates.crt ~/.mitmproxy/mitmproxy-ca-cert.pem > /tmp/devin-diff/ca-bundle.pem

# 1. start capture (background)
mitmdump --listen-host 127.0.0.1 --listen-port 8888 -w /tmp/devin-diff/flows.mitm -q &

# 2. OFFICIAL devin through the proxy (-p = non-interactive; model = SWE-1.6 → swe-1-6-fast)
env HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 \
    SSL_CERT_FILE=/tmp/devin-diff/ca-bundle.pem CURL_CA_BUNDLE=/tmp/devin-diff/ca-bundle.pem \
    NODE_EXTRA_CA_CERTS=/tmp/devin-diff/ca-bundle.pem REQUESTS_CA_BUNDLE=/tmp/devin-diff/ca-bundle.pem \
    ~/.local/bin/devin -p "oi" --permission-mode auto

# 3. CLAUDIN through the SAME proxy (curlFetch inherits env → uses the proxy + CA)
env HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 \
    SSL_CERT_FILE=/tmp/devin-diff/ca-bundle.pem CURL_CA_BUNDLE=/tmp/devin-diff/ca-bundle.pem \
    DEVIN_DEBUG_DUMP_REQ=1 \
    bun --preload ./src/stubs/test-preload.ts scripts/profile/devin-repro.ts swe-1-6-fast \
        +sys +tools +real file=/tmp/devin_tools.json

# 4. extract both requests offline (use mitmdump -nr; system python can't import mitmproxy)
cd /tmp/devin-diff && mitmdump -nr flows.mitm -s <repo>/scripts/profile/devin-re/dump.py -q

# 5. decode + diff
node <repo>/scripts/profile/devin-re/scan.mjs  cap/req1.body "OFFICIAL"
node <repo>/scripts/profile/devin-re/scan2.mjs cap/req1.body "OFFICIAL"
node <repo>/scripts/profile/devin-re/scan2.mjs cap/req3.body "CLAUDIN"

# 6. CLEAN UP — flows.mitm + cap/*.body contain the session token + Authorization headers
rm -f /tmp/devin-diff/flows.mitm /tmp/devin-diff/ca-bundle.pem /tmp/devin-diff/cap/*.body
pkill -f 'mitmdump --listen-host 127.0.0.1 --listen-port 8888'
```

**Identify which flow is which** (no UA needed): official = HTTP/1.1, no connect
gzip, has `sentry-trace` (== the CLI error's trace ID), Authorization ~385
(minted user_jwt), metadata 981 B **with** f31. Claudin = HTTP/2,
`connect-content-encoding: gzip`, UA `chisel/2026.5.26-5` (hardcoded; official is
`-8`), Authorization ~195 (persistent token direct), metadata 245 B, **no** f31.

## Red herrings that cost hours (don't repeat)

- **Per-tool "safety classifier" boundary.** A sequential single-tool scan showed
  a clean "index 16 (Read) onward is BLOCKED" boundary that looks like a
  description classifier. It is not — re-running the *earlier* OK tools blocks
  them too; the boundary is just where the account hit its cap. Any
  request-by-request content bisection manufactures a phantom trigger phrase
  because each request spends quota.
- **Wrong-endpoint PKCE 401** — the codeium `ExchangePKCEAuthorizationCode`
  endpoint 401s Devin codes regardless of header/state/transport; the fix was the
  endpoint URL, not header fingerprinting.
- **Doubled `devin-session-token$` prefix** — chisel itself sometimes emits the
  prefix twice and the server accepts it 200; not a Claudin bug.
- **`getrandom(16)` as f31 entropy** — those are Rust `HashMap`/`RandomState` DoS
  seeds; the crypto material is the `getrandom` 32 B ×6 calls.
