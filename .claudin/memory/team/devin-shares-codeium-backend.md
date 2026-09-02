---
name: Devin CLI reuses Windsurf cloud backend
description: Devin CLI (Cognition) talks to the same server.codeium.com Connect-RPC backend as Windsurf, distinguished only by extension_name/ide_name="chisel" — informs the planned Claudin /provider devin preset
type: project
---

Devin CLI (`v2026.5.26-5`, binary at `~/.local/share/devin/cli/_versions/<v>/bin/devin`) is a Rust binary that talks to the **same Cognition cloud backend** Claudin's Windsurf preset already targets:

- Chat: `https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage` (identical wire format).
- Auth token: `~/.local/share/devin/credentials.toml` — field literally named `windsurf_api_key`, value shape `devin-session-token$<JWT-HS256>` (same scheme Windsurf uses).
- Backend disambiguates **Devin vs Windsurf entitlement by metadata fields**, not by host. Devin sends `extension_name="chisel"` / `ide_name="chisel"` / `extension_version="2026.5.26-5"`. Windsurf sends `extension_name="windsurf"`.
- Catalog endpoint is *different*: Devin uses `GetCliTeamSettings` (entitlement-aware, returns only the UIDs the account can use). Windsurf uses `GetCascadeModelConfigs` (returns all UIDs with a `disabled` field that does NOT reflect per-account entitlement — see related finding below).
- `~/.config/devin/config.json` carries `devin.org_id` (`org-...`); not yet confirmed whether it goes in chat metadata or only in catalog calls.
- Other hosts seen but not load-bearing for chat: `app.devin.ai`, `api.devin.ai`, `static.devin.ai/cli/...` (auto-updater manifest), `api.raindrop.ai` (analytics), `codeium-i5.sentry.io`, `cascadeplayground.watchdevinwork.com`.

**Related finding — UID format and 403 root cause:** `server.codeium.com` accepts *both* hyphen-format UIDs (`claude-opus-4-7-medium`) and protobuf-enum literals (`MODEL_CLAUDE_4_5_OPUS`, `MODEL_PRIVATE_2`, `MODEL_GOOGLE_GEMINI_3_0_FLASH_*`) as valid `modelUid`s; mixing them in `VARIANT_CATALOG` is **not** the cause of Devin-Pro accounts getting 403s through the Windsurf preset. The 403 is entitlement-gating triggered by `extension_name="windsurf"` — a Devin-Pro-only test account gets `permission_denied` for every chat call even though the Cascade catalog reports `disabled=false` for all 136 entries. The Cascade `disabled` field is set later in-memory by `markCatalogEntryDisabled` after a 403, not by the server's initial response.

**Why:** RE session 2026-06-05 captured devin's traffic via mitmproxy after the user reported "all Windsurf models error" on a Devin-Pro test account. The plan to add a `devin` /provider preset that reuses the windsurf/cloud + shim modules with parametrized identity metadata is in `~/.claudin/plans/twinkly-toasting-pine.md`.

**How to apply:**
- When the user reports model 403s on the Windsurf preset, ask which Cognition product they're paying for (Devin Pro vs Windsurf) before assuming it's a UID/catalog bug.
- Do **not** rewrite `VARIANT_CATALOG` to remove `MODEL_*` enum-literal UIDs — they are valid; the server understands them. Removing them would silently drop real models from the picker.
- The planned `devin` preset should reuse `windsurf/cloud/*` and `windsurf/shim/*` unchanged; only parametrize `windsurf/cloud/metadata.ts` with an optional `appIdentity` (ideName/extensionName/version/ideType) and add a Devin-specific token loader + catalog parser.
- Default model for Devin preset: `claude-opus-4-8-medium` (Devin CLI's own default, per `~/.config/devin/config.json` `agent.model`).
