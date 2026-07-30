---
name: Public docs site claudiolabs.ai lives outside this repo
description: claudiolabs.ai hosts the marketing site + /docs pages; its source is NOT in this checkout, and its URLs are extensionless — link absolute URLs from README, never relative site/ paths
type: reference
---

The public site/docs for Claudin is **https://www.claudiolabs.ai/** and its source is **not tracked in this repo** — there is no `site/` directory on `origin/main`.

**Consequences (hit on 2026-07-29):**
- The README title used `<img src="site/img/icon.png">`, which 404s on `raw.githubusercontent.com`, so the header image rendered broken on GitHub. Use the hosted asset `https://www.claudiolabs.ai/img/icon.png` instead. Any other `site/...` relative reference in repo docs is equally dead.
- The server **strips `.html`**: `…/docs/agents.html` 302s to `…/docs/agents`. Link the extensionless form so links don't redirect.
- `www` and apex both serve 200; `sitemap.xml` lists the canonical apex form. Either host works.

**Page inventory** (from https://www.claudiolabs.ai/sitemap.xml — re-fetch it rather than trusting this list):
top level `install`, `providers`, `migrate-from-claude-code`, `changelog`; under `docs/`: `configuration`, `agents`, `workflows`, `skills`, `plugins`, `mcp`, `hooks`, `automation`, `bash-output-filter`, `cache-policy`, `notifications`, `read-outline`, `web-researcher`.

**How to apply:** the README's Features list was deliberately deleted on 2026-07-29 because it duplicated and drifted from these pages — the README now has a `## Documentation` section that links them. When asked to document a feature in the README, add a link to the corresponding site page instead of re-describing the feature, and curl the URL to confirm 200 before committing (dead links are invisible locally).
