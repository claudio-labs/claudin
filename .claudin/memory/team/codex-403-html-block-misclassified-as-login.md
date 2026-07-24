---
name: Codex 403 HTML-block page misclassified as "Please run /login"
description: A Codex 403 with an HTML body is an OpenAI/Cloudflare edge block, not a revoked token, but Claudin's generic 401/403 handler tells the user to /login
type: project
---

A Codex/ChatGPT-OAuth **403 whose response body is HTML** (an OpenAI/Cloudflare
"access denied" / blocked page — telltale CSS like `.blocked-icon{color:#ef4444}`,
`.message`, `.explanation`) is an **edge/CDN block on the network/IP side**, not an
auth problem. It is rejected before reaching the Codex auth layer.

**Why:** Claudin's generic 401/403 branch in `src/services/api/errors.ts` (~line
956-972) maps *any* interactive 401/403 to `Please run /login · <API error>`. Only a
403 containing the string `OAuth token has been revoked` (errors.ts:930-939) is a
real token problem; and `shouldRetry` (withRetry.ts:945-964) does NOT retry a bare
403 (returns false unless OAuth-token-revoked). So the HTML edge-block 403 surfaces
as a misleading "/login" suggestion — re-logging in never fixes it.

**How to apply:** When a user reports a Codex 403 + "Please run /login", ask for the
body: if it's HTML (blocked page), the cause is VPN/proxy/datacenter-IP reputation,
region not served, or Cloudflare fingerprinting the request (codexShim impersonates
the Codex CLI UA/headers at codexShim.ts:565-599) — NOT credentials. Fix is
network-side (residential IP, check ChatGPT in a browser on the same network).
Open improvement candidate (not yet implemented): make the handler distinguish an
HTML-body edge-block 403 from a token-revoked 403 and stop suggesting /login.
Surfaced 2026-07-23 by a pt-BR user hitting this on Codex.
