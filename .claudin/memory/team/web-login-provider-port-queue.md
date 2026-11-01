---
name: opencode web-login providers still missing from claudin
description: Concrete port queue of OAuth providers opencode ships and claudin doesn't — file paths, recommended order
type: project
---

After xAI lands, opencode still has these OAuth providers claudin lacks. Source files live in sibling repo `/home/viudes/projects/opencode/packages/opencode/src/plugin/`.

**Why:** Recurring user ask is "what else can we port from opencode" — having the inventory pre-mapped saves a fresh Explore pass each time.

**How to apply (suggested order, highest value first):**
1. **GitLab Duo** — external npm pkg `opencode-gitlab-auth` (referenced in `plugin/index.ts:16`). Enterprise relevance.
2. **DigitalOcean** — `plugin/digitalocean.ts`. Small, self-contained.
3. **Azure OAuth** — `plugin/azure.ts`. Current claudin Azure preset is API-key only; this upgrades it.
4. **Poe** — external pkg `opencode-poe-auth` (`plugin/index.ts:17`). Aggregator; lower priority.

**Cloudflare — DONE (2026-06-21, commit c6b2d20a):** shipped as two plain API-key presets `cloudflare-workers-ai` + `cloudflare-ai-gateway`, NOT the OAuth path this memory assumed. Cloudflare uses API tokens (`Authorization: Bearer`), not OAuth, so no web-login flow was needed; see openai-compat-preset-recipe.md. Also shipped same day: `zai` (Z.AI GLM Coding Plan, commit 980aabd7).

Reusable opencode plumbing (already mirrored in claudin, do NOT re-port): token store, callback server, PKCE helpers (`src/providers/oauth/`, `src/shared/browser.ts`).

Each new port currently requires cloning the Codex-style `<XxxOAuthSetup>` component in `ProviderManager.tsx`. The longer-term cleanup is to port opencode's `Method`/`Authorization`/`prompts` two-step from `packages/opencode/src/provider/auth.ts` so future providers register declaratively — explicitly deferred per user decision in plan luminous-popping-clarke.md.

Already shipped or settled (NOT in this queue; status corrected 2026-11-01): Anthropic OAuth, Codex/ChatGPT, GitHub Copilot device-flow, xAI (merged on main, verified 2026-09-10 — [[xai-oauth-provider-shipped]]). Windsurf and Devin never merged: the Windsurf branch lived on the retired Gitea remote and was archived 2026-09-21 ([[windsurf-upstream-reference]]); the Devin port halted on f31 ([[devin-provider-port-halted]]).
