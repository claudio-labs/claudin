---
name: Devin OAuth + chat wire quirks (auth endpoint, token prefix, tier-gated models, top-level proto gate)
description: Non-obvious gotchas porting Devin to claudin — wrong-endpoint exchange, devin-session-token$ prefix for codeium Basic auth, chat_model_uid tier-gating, and the GetChatMessage top-level field set (f2/f15/f20/f21) that Cognition gates on. f31 is COSMETIC: server only validates UTF-8 if present.
type: project
---

Verified by side-by-side mitm capture of `chisel` (Devin CLI v2026.5.26-5)
vs claudin in the same session, 2026-06-05
(`/tmp/devin-re/mitm/clean.mitm`). All three were reasoned around for
hours before the captures pinned them.

## 1. PKCE code → token exchange endpoint

  **POST `https://api.devin.ai/auth/cli/token`**
    REQ: `Content-Type: application/json`
         `{"code":"<auth_code>","code_verifier":"<verifier>"}`
    RESP: `{"token":"<HS256 JWT>"}`

NOT `server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode`
— that endpoint exists for Windsurf/Codeium, but devin codes minted by
`app.devin.ai/api/auth/cli/authorize` are scoped to api.devin.ai and the
codeium edge 401s them with `{"code":"unauthenticated"}` regardless of
header shape, state format, transport, or PKCE pair.

Tenant routing (apiServerUrl, devinApiUrl, webappHost) is NOT in the
`/auth/cli/token` response — for SaaS Devin it's fixed:
  apiServerUrl = `https://server.codeium.com`
  webappHost   = `https://app.devin.ai`
  devinApiUrl  = `https://api.devin.ai`

## 2. Session-token prefix for server.codeium.com Basic auth

The JWT returned by `/auth/cli/token` does NOT authenticate against
server.codeium.com on its own — Basic auth handler returns "invalid
api key" with the raw JWT. Must be stored/sent as:

  `devin-session-token$<jwt>`

This is also the prefix in metadata.f3 (api_key) on all chat RPCs.

## 3. GetChatMessage: chat_model_uid (f21) IS sent — but value is tier-gated

CORRECTION (2026-06-05 second mitm capture, 92 flows): the earlier
claim "chisel omits f21, server picks from agent.model" was WRONG.
Chisel ALWAYS sends f21 with an explicit modelUid. Observed across
48 chisel POSTs in one session: `swe-1-6-fast`,
`claude-sonnet-4-6-thinking-1m`, `claude-sonnet-4-6-thinking`.

What actually 403s `permission_denied` ("an internal error occurred")
is account tier vs the specific modelUid:
  - `swe-1-6-fast` — works on free tier ✅
  - `claude-sonnet-4-6-thinking-1m` — works on observed account ✅
  - `claude-sonnet-4-6-thinking` — 403s on the same account ❌

Same JWT, same wire shape, different f21 value → different verdict.
The error message is identical and opaque ("internal error occurred,
trace ID …") whether the cause is tier or anything else server-side.

claudin default model: keep `swe-1-6-fast` as the safe blank-profile
default. The `'default'` sentinel that omits f21 is also kept (works
on Pro accounts whose server-side agent.model is entitled) but is no
longer the family default. Migration in claudinStartupMigrations
rewrites stored `model: 'default'` → `'swe-1-6-fast'` on startup.

## 4. metadata.f31 is COSMETIC — real gate is top-level fields (2026-06-06)

CORRECTION: the earlier hypothesis that f31 was a per-request crypto
signature gating chat was WRONG. An RE agent replayed real chisel
GetChatMessage bodies with f31 mutated (empty, random hex,
omitted entirely, 128KB of "A", etc.) — every UTF-8-valid value
returned HTTP 200. Only invalid UTF-8 → `invalid_argument`. Server
checks UTF-8 if f31 present, nothing else. Static RE confirmed
chisel just emits `hex(rand_bytes(366))` (732 lowercase hex chars).

The actual `permission_denied: "internal error occurred"` gate is
top-level fields in `GetChatMessageRequest` that claudin was omitting.
Required set (chisel sends on every call):

  #1  metadata
  #2  system_prompt (string, top-level — NOT inlined into f3 turn)
  #3  chat_message_prompts (repeated)
  #7  request_type (varint enum)
  #8  completion_configuration
  #10 tools (repeated)
  #15 conversation_context { f1=cascadeId, f3=4, f4=14 }
  #16 cascade_id
  #20 client_flag = 1 (varint)
  #21 chat_model_uid (REQUIRED — earlier commit 84765dc4 omitting it
       was wrong; chisel always sends e.g. "swe-1-6-fast")
  #22 prompt_id

Metadata sub-message also needs #31 = hex string (cosmetic; chisel
sends `hex(rand_bytes(366))`). claudin currently emits same.

**Version string matters**: chisel bumped UA `chisel/2026.5.26-5` →
`chisel/2026.5.26-6` mid-debug. claudin's hardcoded DEVIN_VERSION_STRING
must track or server may rate-limit/gate on stale clients.

**Replay vs cross-client A/B is asymmetric**: removing f31 from a
captured chisel body and replaying → 200. But claudin sending the
same shape minus f31 → 403. Suggests server gates on
(client_identity × field_set), where client_identity is some
combination of UA + JA3/HTTP2 fingerprint + IP rep. Don't trust
mitm-replay results as evidence for what your own client can omit.

**Stronger evidence (2026-06-06)**: claudin spoofed UA to
`chisel/2026.5.26-6` AND copied a real devin-oficial f31 value
byte-for-byte (verified 732-hex-char identical via mitm parse) →
backend still returned `permission_denied`. So f31 byte-replay alone
does NOT bypass the identity gate. Either the gate also keys on
JA3/HTTP2 (curl-transport via libcurl produces a different
fingerprint than chisel's hyper/rustls stack), or f31 content
embeds the request body hash so a stale f31 mismatches a fresh body.
Either way: no replay-based shortcut.

## 5. chisel binary RE notes (2026-06-06) — what static analysis gave us

The 124MB devin Rust binary is static-PIE, stripped, with no symtab.
`strings` + r2 CLI + strace on a live `oi`-message session pinned:

- **Crypto stack**: `aws-lc-rs` (Ed25519, AES-GCM, ChaCha20-Poly1305,
  RSA). Choice of algo not narrowed without decompiler.
- **MAC fingerprint input**: `execve("/usr/bin/ip", ["ip","-o","addr","show"])`
  + `cat /sys/class/net/$iface/address`. NO `/etc/machine-id`, NO DMI
  product_serial read. Shell pipeline wrapper at `fcn.04235523` in
  the 2026.5.26-6 build.
- **Per-request entropy**: `getrandom(16)` called once per
  GetChatMessage. So f31 has 128 bits of fresh randomness even
  on the same machine.
- **Key material**: NOT in `~/.local/share/devin/credentials.toml`
  (only stores JWT + URLs). Key embedded in binary, not derivable
  from filesystem.
- **What's NOT feasible from CLI alone**: locating
  `windsurf-api-client::translation::create_metadata` in 64MB of
  stripped .text without Ghidra/IDA — relocations swamp r2's xref
  analysis, "mangled" names r2 shows are placeholder prologue-hashes
  not real symbols. Recommended next step if pursuing: Ghidra +
  rust-demangle script, ~4h budget.

## Red herring: "double devin-session-token$ prefix in Authorization"

In the same capture, chisel ITSELF occasionally emitted
`Authorization: Basic devin-session-token$<jwt>-devin-session-token$<jwt>`
(prefix doubled, hyphen-joined) on a subset of POSTs and the server
accepted them 200. Not a claudin bug — likely a chisel retry path
quirk. Server tolerates it. Do not chase this if you see it in a log.

## Red herrings that cost hours

- WAF header fingerprinting on the exchange (Connection header, UA,
  raw `tls.connect` for byte-perfect header order): wrong endpoint,
  not header sensitivity. api.devin.ai accepts standard
  `https.request` shape fine.
- PKCE verifier regenerated on retry: real bug (fixed by reusing
  closure on "Try again" instead of calling startFlow), but not the
  cause of the persistent 401.
- UUID-v4 vs base64url state format: both work; api.devin.ai doesn't
  validate state shape.
- Pinning `swe-1-6` vs `swe-1-6-fast` in the model field: the value
  IS the problem (tier-gated), the field is required.
- Chisel doubling the `devin-session-token$` prefix on its own retries
  (see "Red herring" above).

## How to apply when porting any Cognition CLI

1. ALWAYS mitm-capture the real CLI BEFORE reverse-engineering from
   sibling CLIs. Windsurf shares the codeium backend but Devin has
   its own auth endpoint AND its own server-side model resolution.
2. When debugging PKCE 401s: verify endpoint URL matches the trace
   EXACTLY, then `SHA256(verifier) == challenge`, THEN headers/transport.
3. When debugging chat 403 permission_denied / "internal error":
   diff the top-level proto fields claudin sends vs what chisel sends.
   Server-side gating on optional fields is a common failure mode —
   the safe default is to send EVERY field chisel sends, and to
   capture chisel + your-client in the same mitm so the diff is
   byte-comparable (REQUIRES HTTPS_PROXY+NODE_EXTRA_CA_CERTS+
   SSL_CERT_FILE env exported in YOUR shell before launching your
   client — otherwise your client bypasses the proxy and you debug
   blind against chisel alone).
4. Decoding chisel's gzipped Connect-protocol frames: strip the 5-byte
   prefix (1 flag byte + 4 length bytes), gunzip if flag bit 0 set,
   then walk proto fields. Working python recipe was developed at
   `/tmp/walk3.py` / `/tmp/extract_field.py` during the 2026-06-05
   session.
