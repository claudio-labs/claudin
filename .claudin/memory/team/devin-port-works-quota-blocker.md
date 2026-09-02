---
name: Devin port — f31 attestation RE-IMPLICATED by clean-window A/B; prior "f31 not enforced / rate-limit blocker" did NOT survive retest
description: 2026-06-12 PM clean-window A/B (official CLI shows Pro 100% remaining, resets 8h46m, and SUCCEEDS) reverses the earlier conclusion. With a real Pro quota, official `devin` (metadata.f31 present) gets a real reply; Claudin (f31 ABSENT, metadata otherwise byte-identical, same valid UID swe-1-6-fast) gets permission_denied "an internal error occurred". Transport (curl HTTP/2+gzip) already exonerated. So f31 — NOT a rate limit — is the prime suspect again. The "rate-throttle / f31 dead" sections below are the OLD (confounded) conclusion; read the CONTRADICTION block first.
type: project
---

## ⚠️ CONTRADICTION — clean-window A/B 2026-06-12 (PM) reverses everything below

Re-ran the mitmproxy A/B (team/devin-wire-ab-procedure.md) when the official
CLI banner showed **"Pro · 100% remaining (resets in 8h 46m)"** — i.e. NO
rate limit in play. Results:

- **OFFICIAL `devin -p "oi"` → SUCCESS** (real reply "Oi! How can I help…").
  Two GetChatMessage requests captured: req1 model UID `swe-1-6` (7 bytes),
  req2 `swe-1-6-fast` (12 bytes). BOTH carry `metadata.f31` (732-hex) and
  BOTH succeed. So `swe-1-6-fast` IS valid *with* f31.
- **CLAUDIN (repro, `swe-1-6-fast`, no f31) → permission_denied "an internal
  error occurred"** (trace f7563d2d…). Same valid UID official used in req2.
- **Metadata byte-identical** for sub-fields 1,2,3,4,5,7,12 (lens
  6,11,189,2,5,11,6). **The ONLY structural metadata difference is f31:
  official has it (981-byte metadata), Claudin omits it (245-byte metadata).**
- **Transport is exonerated** as the cause: curlFetch's HTTP/2+gzip path is
  the very path that previously reached the rate-limiter, so the edge/TLS
  gate accepts it. Today's opaque error is downstream of the edge.

**Therefore: f31 is the prime suspect again, and the blocker is NOT a rate
limit (Pro quota was 100% free).** The old "f31 NOT enforced" rested on a
single data point — Claudin-no-f31 getting "Reached message rate limit",
read as "authenticated+accepted". That reasoning is unsafe: the clean-window
retest shows Claudin-no-f31 does NOT get a real completion when quota is
available; it gets the opaque permission_denied.

**Unresolved tension (do not overclaim f31 is confirmed):** the old notes
also assert "Claudin completed ~30 real chat turns with no f31." If literally
true, f31 can't be a hard gate — but that ~30-completion claim was an
*inference*; the only decoded captures of a no-f31 request are FAILING ones.
Possible resolutions: (a) f31 became enforced server-side, (b) the ~30
completions actually had different state, (c) a metadata sub-field VALUE
differs (scan2 only compares LENGTHS; e.g. client version is `-5` in Claudin
vs `-8` official, both 11 bytes — could matter). To truly confirm f31, need
to control transport AND inject a valid f31 (the sealed 366-byte attestation
from the closed binary — hard) OR capture a genuinely-succeeding no-f31
request. Until then: f31 re-implicated, not proven.

Cosmetic diffs still present: UA `chisel/2026.5.26-5` vs official `-8`;
Claudin Authorization len 195 (persistent token) vs official 385 (minted
user_jwt) + `sentry-trace` header; HTTP/2+gzip vs HTTP/1.1 no-gzip.

---

## OLD CONCLUSION BELOW (2026-06-12 AM — CONFOUNDED by a rate-limit window, kept for the audit trail; do not trust the "f31 dead" / "rate-limit is the only blocker" claims)

Verified 2026-06-12 on a real Devin test account (rebased feat/devin-provider).

## Conclusion
The Devin port is **functionally correct** — do NOT chase a code bug, f31,
a tool-description safety classifier, or a JWT-refresh bug (chat path sends
the persistent `devin-session-token$<JWT>` directly BY DESIGN — auth.ts:104:
"the Devin chat/catalog flows no longer use mintUserJwt"). The live failure
is the raw `server.codeium.com` inference backend **throttling a burst of
automated requests**, surfaced as the SAME opaque `permission_denied: "an
internal error occurred (trace ID: …)"` Cognition also uses for
tier-gating / quota.

CORRECTION (2026-06-12, user's app.devin.ai dashboard screenshot): it is
**NOT account quota**. Usage & Limits showed **Pro plan, Daily 0% used,
Weekly 0% used** even after ~60 of my requests → the chat RPCs don't
decrement the dashboard ACU quota at all. The cap hit is a separate
per-account/IP rate/abuse limit on the inference endpoint that the
dashboard doesn't surface. Corroboration: Codeium GH #221 (permission_denied
= free-account-exceeded / paid-model-on-free-account) and #317 (exact
"internal error occurred (trace ID)" string, sometimes self-resolves
backend-side). Window > 180s; likely clears in hours / by daily reset.

## Wire A/B vs official chisel (2026-06-12) — f31 NOT enforced, model-UID matters
Captured official `devin` CLI (v2026.5.26-8) and Claudin side-by-side through
mitmproxy (recipe: mitmproxy-rust-binary-recipe.md), both POSTing
GetChatMessage to server.codeium.com. Decoded both protos:
- **metadata (field 1) is byte-identical** between official and Claudin for
  sub-fields 1,2,3,4,5,7,12 (lens 6,11,189,2,5,11,6). The ONLY difference:
  official sends `metadata.f31` (732-hex-char string), **Claudin omits it
  entirely**.
- **f31 is NOT a gate.** Claudin (no f31) + `swe-1-6-fast` → `Reached message
  rate limit` (= authenticated + accepted, just rate-capped) — identical
  verdict to official (WITH f31) + `swe-1-6-fast`. And earlier this session
  Claudin completed ~30 real chat turns with no f31. A native curl-transport
  client without f31 works; the §4 "client_identity/JA3 gate" worry in
  devin-oauth-quirks.md is resolved — it was the free-tier/model-UID issue,
  not f31. **The 2026-06-06 "f31 HARD BLOCKER" is fully dead.**
- **Model UID is the real opaque-error trigger:** Claudin + `swe-1-6` (7 bytes)
  → `permission_denied "an internal error occurred"`; same client + same (no)
  f31 + `swe-1-6-fast` → rate-limit (works). The official UI's "SWE-1.6" maps
  to UID **`swe-1-6-fast`**, NOT `swe-1-6`. Official req also used
  `claude-sonnet-4-6-thinking` (field 21). So: use `swe-1-6-fast`; `swe-1-6`
  is invalid/not-enabled → opaque error (Claudin maps it to "model not
  enabled", which is essentially correct).
- Other harmless wire diffs: Claudin uses HTTP/2 + connect gzip + UA
  `chisel/2026.5.26-5` + no sentry-trace + a shorter (195-char) Authorization
  (sends the persistent token directly; official mints a ~385-char user_jwt
  and adds `sentry-trace`). None of these block Claudin.

## DEFINITIVE confirmation (2026-06-12)
The **official Devin CLI hits the identical wall** with the identical
trailer (user screenshot): `Permission denied: Reached message rate limit
for this model. Please try again later. Resets in: 2h50m42s (trace ID: …)`.
Claudin surfaces the **exact same message verbatim** (chat.ts:1165 passes
the trailer message through; the rate-limit text does NOT match the
`/an internal error occurred/` enrich branch, so it is shown as-is). So:
the port is correct and client-identical; the blocker is a Devin **per-model
message rate limit** (note "for this model" — switching model UID may work
immediately), reset window ~3h. Nothing to fix in Claudin's Devin code.

## Evidence
- ~30 real GetChatMessage calls succeeded back-to-back at session start,
  incl. a 39.7k-token / 28-tool request → full streamed completions.
  Transport (curlFetch/JA3), auth (`devin-session-token$`), model
  (`swe-1-6-fast`), proto + tools all work.
- After ~30 calls, EVERYTHING began returning permission_denied — incl.
  the bare no-tools call and tools (Bash, Agent) that worked seconds
  earlier. 180s cooldown did not reset (window is hourly/daily).

## False lead — do not repeat
A sequential single-tool scan produced a clean "index 16 (Read) onward is
BLOCKED, before is OK" boundary that looks exactly like a per-tool
classifier flagging Read's description ("Reads a file from the local
filesystem. You can access any file directly…"). **It is not.** Re-running
the *earlier* OK tools afterward blocks them too — the boundary is just
where the account hit its cap. Any request-by-request content bisection
will manufacture a phantom "trigger phrase" because each request spends
quota.

## Repro harness (untracked, on the branch checkout)
- `scripts/profile/devin-repro.ts` — loads the Devin profile, calls
  streamChatEvents; flags: `+sys +tools +heavy +huge +real file= names= slice=`.
- `scripts/profile/devin-extract-tools.ts` — pulls tools[] from a captured
  proto (DEVIN_DEBUG_DUMP_REQ=1 → /tmp/claudin_last_req_*.proto.bin, gunzip).
- `scripts/profile/devin-tool-scan.sh` — per-tool pass/fail (BURNS quota fast).
Run with `bun --preload ./src/stubs/test-preload.ts`. Reads the active
provider profile, so global activeProviderProfileId must be the Devin one
(or run from a non-git cwd so no project override applies).

## To actually use Devin
Needs quota headroom — paid/seat tier or a fresh window. Possible code
follow-up: don't retry permission_denied (wastes 3× quota per failure via
withRetry), and soften the error text which currently asserts tier-gating
when it may be quota.
