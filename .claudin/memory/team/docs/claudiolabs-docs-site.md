---
name: Public docs site claudiolabs.ai lives outside this repo
description: claudiolabs.ai (marketing + /docs) is built from the sibling repo claudio-labs/claudin-site, which also publishes llms.txt + .md mirrors that claudin-guide reads; URLs are extensionless — link absolute URLs from README, never relative site/ paths
type: reference
---

The public site/docs for Claudin is **https://claudiolabs.ai/** and its source is **not tracked in this repo**. It lives in the sibling repo **claudio-labs/claudin-site** (checked out at `~/projects/claudin-site`): hand-written static HTML under `site/`, deployed to Cloudflare Pages by `.github/workflows/deploy.yml` on every push to its `main`.

**Consequences (hit on 2026-07-29):**
- The README title used `<img src="site/img/icon.png">`, which 404s on `raw.githubusercontent.com`, so the header image rendered broken on GitHub. Use the hosted asset `https://www.claudiolabs.ai/img/icon.png` instead. Any other `site/...` relative reference in repo docs is equally dead.
- The server **strips `.html`**: `…/docs/agents.html` 308s to `…/docs/agents`. Link the extensionless form so links don't redirect.
- `www` and apex both serve 200; `sitemap.xml` lists the canonical apex form.

**The agent-facing copy (since 2026-09-27, claudin-site#1):** at deploy time, `scripts/build-llms.js` writes `/llms.txt` (grouped like the docs sidebar) and a `.md` mirror of every sidebar page (`/docs/<page>.md`, `/install.md`, …). `CHANGELOG.md` is published as `/changelog.md`. These files are gitignored in that repo, and all of them are served as `text/markdown`. The `claudin-guide` agent (`src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`) starts from `llms.txt`, and `claudiolabs.ai` is in WebFetch's `PREAPPROVED_HOSTS`. That combination is what makes WebFetch return the pages verbatim instead of summarizing them. It also keeps the guide from being denied under its `dontAsk` mode.

**How to apply:**
- For the page inventory, fetch `https://claudiolabs.ai/llms.txt`; don't keep a list here.
- To document a feature, add a page to claudin-site's sidebar. The generator picks it up with no other change.
- Stale site docs now become stale guide answers, so fix a wrong page on the site, not in the guide's prompt.
- In the README, link the site page instead of re-describing the feature. The README's Features list was deleted on 2026-07-29 because it drifted. Curl the URL for a 200 before committing.
- Watch `/changelog.md`: it was 79 KB on 2026-09-27. Above WebFetch's `MAX_MARKDOWN_LENGTH` (100k chars), it stops coming back raw and gets truncated and summarized instead.
