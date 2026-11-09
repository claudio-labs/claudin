---
name: dependabot-bumps-2026-11-09-audited
description: Dependabot #342/#343/#344 (2026-11-09) — knip 6.44.1 needed a baseline refresh (import().then() member tracking); SDK 1.6 now sets error.name; the rest audited, no action
type: project
---

All three merged 2026-11-09 after a rebase onto main (#343/#344 were red only on
the 6 tests #341 had already fixed).

- **knip 6.44.1 (#342) — baseline refreshed, no code change.** It now tracks the
  members destructured in `import('x').then(({ foo }) => …)` (knip#2264); 6.44.0
  counted the whole namespace as used. That surfaced 23 pre-existing unused
  exports in the six modules reached only that way (`commands/clear/caches.ts`,
  `platform/setup.ts:289`). `bun run deadcode:baseline` also dropped 64 entries
  that had become used since 09-25 — among them
  `teammate.ts#setDynamicTeamContext`, one of the two "known FALSE" entries
  (a test imports it now); the `scripts/verify/deadcode-ci.ts` header was
  corrected to name only `formatTeammateMessages`.
- **@anthropic-ai/sdk 1.3 → 1.6 (#343) — no action.** Still posts beta endpoints
  bare with `__qualifiers`; the #340 fix still fires (`client.test.ts` pins
  create, countTokens and a retry against the real SDK). Errors now set `name`
  from a static `_errorName` (survives minification), so the
  `name === 'APIUserAbortError'` checks in `turnLoop.ts` / `promptSuggestion.ts`
  started matching. `e.name` names only the leaf class, so the chain walk in
  `src/shared/errors.ts` stays (its comment was corrected to say so). New
  subclasses (529 → `OverloadedError`) still extend
  `InternalServerError`. Vertex 1.1.2 percent-encodes project/region/model in
  the URL (`@` and `:` untouched).
- **supports-hyperlinks 5.0 (#344) — no action.** Node ≥22 (floor is 22.19.0),
  same API, `herdr` added; pulls supports-color 11, whose numeric `FORCE_COLOR`
  now pins the level like chalk 6 — hyperlinks only read its truthiness.
- undici 8.12.4 (abort-signal tracking in fetch reworked — the one area not
  exercised live), ws, marked, turndown, semver, firecrawl, google-auth-library,
  bedrock/foundry SDKs: fixes only.
