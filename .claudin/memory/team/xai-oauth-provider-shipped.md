---
name: xAI / Grok OAuth provider — shipped and merged
description: xAI / Grok OAuth login is merged on main (verified 2026-09-10) — loopback PKCE only, audit-clean, device-code flow still deferred to a follow-up
type: project
---

xAI / Grok OAuth login ships as a `/provider` preset. It began on branch `feat/xai-oauth-provider` (2026-06-07, two commits: `9425ad9` feat + `4a339d4c` audit fixes) and **has since merged**: as of 2026-09-10 `main` carries `src/providers/oauth/xaiOAuth.ts`, `xaiOAuthShared.ts`, `xaiCredentials.ts`, `xaiUserAgent.ts` and `src/providers/ui/useXaiOAuthFlow.ts`, each with a colocated test. This paragraph used to end "Not merged" — a 2026-06-07 snapshot that outlived its truth. The filename was right where the body was wrong.

**Why:** First port from opencode's web-login provider set; cloned Codex OAuth path 1:1 instead of generalizing the auth-plugin surface (per user decision in plan luminous-popping-clarke.md).

**How to apply:**
- Branch reuses opencode/Grok-CLI's hardcoded `client_id` and pinned port `56121` (cannot change — part of xAI's client registration). Authorize URL must include `plan=generic` or consent rejects.
- Scope is the wider opencode value `openid profile email offline_access grok-cli:access api:access` (not the narrower one in the original plan) — required because we reuse Grok-CLI's client.
- Refresh-token storage in `.credentials.json` under key `xai`; profile uses `openai_compat` transport against `https://api.x.ai/v1`.
- Audit fixes (commit `4a339d4c`) addressed P1+P2: `expires_in` now persisted for opaque-token refresh; cooldown respects `force:true` (diverges from Codex twin which honors cooldown on force); `isXaiOAuthBaseUrl` is exact host match only; OIDC `nonce` sent on authorize; `User-Agent: claudin/<version>` on API calls; `/provider doctor` xAI check hits `/v1/models`.
- **Device-code (RFC 8628) flow not ported** — non-interactive sessions (SSH/VPS/Docker/CI) hit a dead-end error pointing to interactive `/provider`. Tracked as separate follow-up PR.
- `claudin/dev` UA leaks to xAI under `bun test` because MACRO.DISPLAY_VERSION is build-time-inlined and undefined at test runtime — known minor.
