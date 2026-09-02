---
name: Devin provider port halted; branch feat/devin-provider pushed but not merging
description: 2026-06-06 — feat/devin-provider closed without merge; chisel binary's metadata.f31 attestation is a hard blocker (content-bound, replay-rejected, 366B per-request from getrandom+aws-lc-rs key embedded in binary). Full writeup in docs/tech/devin-provider-blocker.md
type: project
---

`feat/devin-provider` (commit `ec607be` pushed to origin 2026-06-06) is **not landing**. The work is preserved as a reference for any future attempt; the wire-format fixes (OAuth at `api.devin.ai/auth/cli/token`, `devin-session-token$` Basic prefix, `swe-1-6-fast` default, tenant routing, catalog-skip for `default` sentinel, curl-transport fallback) are all correct, but Devin's tier is gated server-side by `metadata.f31`, a 366-byte per-request attestation generated locally by the closed-source `chisel` Rust binary.

What we proved in-session:
- **f31 byte-replay is rejected.** Copying a real chisel-oficial f31 byte-for-byte into a claudin request → `permission_denied` even with UA spoofed to `chisel/2026.5.26-6`. So f31 is content-bound (likely seals a body hash + nonce + machine fingerprint with an embedded key) — not a tier-presence cookie.
- **Static RE from the CLI alone is insufficient.** The 124MB binary is static-PIE, stripped, no symtab; r2 xref analysis is swamped by 3.5MB of relocations and the "mangled" names it shows are placeholder prologue-hashes, not real Rust symbols. Crypto stack identified as `aws-lc-rs`; per-request entropy via `getrandom(16)`; MAC fingerprint via `ip -o addr show` + `/sys/class/net/$iface/address` (no machine-id, no DMI serial). Function wrapping the MAC shell pipeline at `fcn.04235523` in the 2026.5.26-6 build.
- **No prior art exists.** Web survey (WebResearcher 2026-06-06) found zero public RE of f31 or the chisel binary. `opencode-windsurf-auth` predates f31 enforcement; `pqhaz3925/windsurf-proxy` is MITM on top of the official binary; Exafunction OSS plugins shell out to the closed language-server. Architectural pattern across Cognition products: network-facing crypto stays in closed binaries.
- **Asymmetric replay**: omitting f31 from a captured chisel body and replaying via mitm → 200; claudin sending the same shape minus f31 → 403. So the gate is `(client_identity × field_set)`; client_identity is some combination of UA + JA3/HTTP2 + IP rep.

Estimated cost to crack remaining: 4–8h Ghidra + rust-symbol-recovery script, no guarantee, and brittle to chisel updates rotating keys.

**Why:** Cognition rolled out f31 enforcement on Devin tier sometime before 2026-06; previous third-party clients that didn't generate f31 stopped working. Without Ghidra (we're CLI-only here) we can't extract the embedded key or algorithm.

**How to apply:**
- Don't reopen this without a Ghidra/IDA budget and a willingness to maintain it across chisel releases.
- The wire-format commits on `feat/devin-provider` are reusable if Cognition ever publishes a tier-gate alternative (e.g., a proper REST API key for Devin chat).
- Plan B if someone insists: sidecar `devin` headless and lift f31 from its outbound request per call. Functional, no RE, but Cognition can kill headless mode in any release.
- See `docs/tech/devin-provider-blocker.md` for the full writeup committed to main.
- The existing `team/devin-shares-codeium-backend.md` is now historically interesting but operationally stale — the "planned /provider devin preset" is shelved.
