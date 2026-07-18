---
name: Claudin defaults to essential-traffic, suppresses Anthropic startup probes
description: As of commit b2be87b5 (2026-06-06), Claudin's privacy level defaults to 'essential-traffic' so cold start issues 0 requests to *.anthropic.com instead of 7; ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC is a new alias env var; explicit =0/false opts back in to upstream behaviour
type: project
---

Claudin's privacy level (`src/utils/privacyLevel.ts`) defaults to `'essential-traffic'` when neither `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` nor `ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC` is set. Setting either env var to `0`/`false`/`no`/`off`/empty opts back in to upstream-Claude-Code behaviour.

Empirically (mitmproxy on `--allow-hosts anthropic\.com`, cold REPL start, Anthropic-first-party profile):

- **Before**: 7 requests — `POST /v1/messages` (quota warm), `GET /api/claude_cli/bootstrap`, `GET /api/oauth/.../referral/eligibility`, `GET /api/claude_code_penguin_mode`, `GET /api/claude_code/settings` (MDM), `GET /api/claude_code/policy_limits`, `GET /mcp-registry/v0/servers`, plus (uncovered in this session) `GET /api/claude_code_grove`, `GET /api/oauth/account/settings`, `GET /v1/mcp_servers?limit=1000` (claudeai MCP).
- **After**: 0 requests.

To get there, `isEssentialTrafficOnly()` is now also gated in `services/policyLimits/index.ts:isPolicyLimitsEligible`, `services/remoteManagedSettings/syncCache.ts:isRemoteManagedSettingsEligible`, `services/mcp/officialRegistry.ts`, and `services/mcp/claudeai.ts`.

`getEssentialTrafficOnlyReason()` now returns `'claudin-default'` when no env var is set but the level resolves to `essential-traffic`.

**Why:** Claudin is provider-agnostic, so probing Anthropic-only endpoints (org policy, MDM settings, grove, fast-mode, MCP registry, claudeai MCP) is dead weight even when the active profile *is* Anthropic. Telemetry-style probes also leak presence/usage to api.anthropic.com on every launch, which is undesirable for a fork.

**How to apply:**
- When users report "the build doesn't reach my MDM/policy endpoint", check whether they need to set `ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC=0` (opt-in) — the default kills that path.
- The semantics of `DISABLE_TELEMETRY=1` *alone* are now: still `essential-traffic` (more restrictive default wins). To get the old `no-telemetry` level you must opt in (`ANTHROPIC_DISABLE_NONESSENTIAL_TRAFFIC=0` + `DISABLE_TELEMETRY=1`).
- Any new gate that should be skipped under the privacy default should call `isEssentialTrafficOnly()` from `src/utils/privacyLevel.js`, not read the env var directly — otherwise the alias and the new default will be missed.
- Existing tests covering this matrix live in `src/utils/privacyLevel.test.ts` (8 cases).
