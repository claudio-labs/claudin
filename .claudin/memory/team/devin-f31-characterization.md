---
name: Devin f31 attestation — what it is (builder, inputs, crypto shape), from binary + strace RE
description: Evidence-based characterization of metadata.f31 in the official `devin`/chisel binary (v2026.5.26-8). f31 is a client-attestation token SEALED (encrypted-to-server), built in windsurf-api-client/src/translation.rs::create_metadata, binding the machine MAC-set + fresh randomness (+ almost certainly a body hash & timestamp) under a key embedded in the binary. Reproducing it needs the embedded recipient key + suite + plaintext layout (Ghidra-grade RE, brittle per release) OR harvesting f31 from a sidecar official binary per request. Use when deciding how to unblock the Devin port now that f31 is re-implicated.
type: project
---

RE'd 2026-06-12 on `~/.local/share/devin/cli/_versions/2026.5.26-8/bin/devin`
(129MB static-PIE, stripped, Rust). Companion: devin-port-works-quota-blocker.md
(CONTRADICTION block — clean-window A/B shows f31 IS the blocker).

## Where it's built
`windsurf-api-client/src/translation.rs` → `create_metadata` /
`translate_to_windsurf_protobuf` (confirmed via string-path: the module's
tracing strings `windsurf-api-client/src/translation.rs:58..138` are in the
binary). Auth lives in `windsurf-api-client/src/auth.rs`.

## What f31 IS (high confidence)
A **sealed (encrypted-to-server) client-attestation blob**, NOT a plain
signature:
- Fixed **366 bytes**, ~100% entropy at every byte, no magic/version prefix
  → it is ciphertext, not a signed-but-readable payload (an Ed25519 sig over
  a cleartext payload would leave the payload bytes readable; f31 has none).
- **Content-bound**: replaying a byte-identical f31 from a 200 response →
  `permission_denied` (proven earlier). So the sealed plaintext includes a
  request-body hash and/or timestamp/nonce the server checks for freshness.
- Shape consistent with HPKE/X25519 seal (enc 32B + AEAD ct+tag) OR an AEAD
  seal under a key derived from an embedded secret. Do NOT assume HPKE from
  `strings` alone — the binary's DHKEM_X25519/HpkeAead/etc. strings also come
  from rustls' ECH and are not proof f31 uses HPKE.

## Inputs (strace-confirmed, 2026-06-12)
Tracing the official binary emitting one request:
- **Machine fingerprint = the MAC set.** It shells out:
  `sh -c "ip -o addr show 2>/dev/null | awk '{print $2}' | sort -u | tr
  [:upper:] [:lower:] | grep -v ^00:00:00:00:00:00$ | sort -u"` then
  `cat /sys/class/net/<iface>/address` per interface (br-*, docker0, enp5s0…).
  NO /etc/machine-id, NO DMI/product_uuid, NO hostid.
- **Fresh randomness:** getrandom **32B ×6** per run = the crypto material
  (X25519 ephemeral / AEAD key). ⚠️ CORRECTION to the old doc: the many
  getrandom **16B** calls (≈36/run) are Rust `HashMap`/`RandomState` DoS seeds,
  NOT a crypto input. The "getrandom(16) is f31 entropy" note was a red herring.
- Key material (the recipient/sealing key) is **embedded in the binary**, not
  in `~/.local/share/devin/credentials.toml`.
- Crypto lib: **aws-lc-rs 1.16.2** (Ed25519, X25519, ChaCha20-Poly1305,
  AES-128/256-GCM, HKDF; HPKE/DHKEM present but possibly rustls-ECH).

## Purpose
Anti-abuse / anti-third-party-client attestation: binds (machine identity ×
request × time), sealed so only Cognition's backend can open+verify. A
non-chisel client (Claudin) can't forge it without the embedded key AND the
exact plaintext layout. This is why omitting f31 → opaque
`permission_denied: "an internal error occurred"`.

## f31 is PER-REQUEST unique (2026-06-12 confirmed) → port not viable
Captured 4 official GetChatMessage requests (2 identical "oi" messages, each
= 1 chat + 1 title-gen). All 4 f31 values are DISTINCT (4 different sha256),
each 366 bytes, no fixed prefix. Decisive: the two CHAT requests had a
BYTE-identical body size (62551) — same message, same tools — yet different
f31. So f31 carries a fresh nonce/timestamp/ephemeral key per call; it is NOT
a pure function of the body. Cannot be cached or pre-generated.

**DECISION (user, 2026-06-12): do NOT pursue the Devin CLI port.** It is
technically possible but a brittle, non-sustainable port surface:
- Reuse/cache an f31 → impossible (per-request unique; replay rejected).
- Sidecar-harvest from the official binary → impractical (official seals ITS
  body+nonce, won't transfer to Claudin's body).
- Static RE of the embedded key/suite/layout → hours in Ghidra AND rotates
  every chisel release (self-breaks on each binary update).
Contrast attempt — Windsurf is NOT a confirmed escape hatch: it shares the
SAME GetChatMessage chat path where f31 lives (only extension_name differs,
"windsurf" vs "chisel"). Whether the Windsurf tier enforces f31 is UNTESTED:
no Windsurf IDE/language_server binary or Windsurf-entitled account available
here; the only recorded live windsurf-preset attempt (2026-06-05, on a
Devin-Pro account) returned permission_denied for every call (attributed to
entitlement, but indistinguishable from an f31 gate); the branch's 108/108
are UNIT tests, not live backend acceptance. Its OAuth+JSON AUTH surface is
stable (doesn't rotate like f31), but that says nothing about the chat-path
f31 gate. To settle it: get a real Windsurf account, capture the official
language_server's GetChatMessage, check (a) does it send f31, (b) does the
Claudin preset complete live. NOTE: metadata.ts still emits hex(rand_bytes(366))
on the stale "server only validates UTF-8" theory — a random f31 fails the
same as none (server decrypts/validates it). Capture showed Claudin actually
sent NO f31 (245B metadata) — code/runtime inconsistency to verify if pursued.

## (Historical) To unblock the port — both routes rejected above
1. **Sidecar-harvest (pragmatic, works today):** spawn the official `devin`
   headless, intercept its outbound GetChatMessage, lift f31, inject into
   Claudin's metadata. Risk: per-call latency; Cognition could detect via
   timing or drop headless mode. f31 is content-bound, so harvest must be
   per-request for the SAME body — non-trivial (the official binary seals ITS
   body hash, not Claudin's). Likely needs Claudin to build the exact body the
   sidecar will sign, or to drive the sidecar with Claudin's payload.
2. **Full RE (brittle):** Ghidra (not installed here) + rust-symbol recovery,
   xref-anchor on translation.rs strings → find the embedded recipient key +
   AEAD suite + plaintext layout. ~4–8h, rotates each chisel release. r2 alone
   struggles (3.5MB relocs, stripped, fn-pointer dispatch).
