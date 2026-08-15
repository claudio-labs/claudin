---
name: Windsurf upstream reference repo
description: Sibling repo opencode-windsurf-auth holds the reverse-engineered Windsurf cloud wire format, OAuth flow, and proto field tags — Claudin has NO windsurf provider, this is a pure external reference
type: reference
---

The sibling checkout `../opencode-windsurf-auth/` holds the reverse-engineered Windsurf cloud wire format. **Claudin has no windsurf provider slice, and never had one** — `git log --all --diff-filter=A` finds no such file in this repo's history, and the only `windsurf` matches under `src/` are the Windsurf *editor* integration (terminal/IDE detection), not a provider. Like the archived Devin one, this is a pure external reference: check it before guessing at a wire-format question, and treat it as the starting point if a port is ever attempted.

Where to look inside that repo:
- `src/cloud-direct/{chat.ts,wire.ts,auth.ts,metadata.ts,catalog.ts}` — Connect-RPC encoder, proto field tags, EOS-trailer handling, two-token auth.
- `src/oauth/{login.ts,register-user.ts,types.ts}` — loopback Firebase OAuth, RegisterUser → api_key exchange.
- `docs/CLOUD_DIRECT.md` — captured-body table with proto field numbers (1/3/7/8/10/16/21/22 on the request side; 3/5/6/9/28 on the response), the "Connect-Content-Encoding: gzip → opaque 200" trap, two-step auth handshake.
- `docs/OAUTH.md` — `GetSelfDevinSessionToken` fallback for api_keys missing the `devin-session-token$` prefix.

Details a port would have to match, and the ones easiest to get wrong: source-3 system collapse with `<system>...</system>` wrapping, pinned `WINDSURF_VERSION_STRING='2.0.0'` + `ide_name/extension_name/ide_type='windsurf'` metadata, stop-reason table (STOP_PATTERN=2 vs MAX_TOKENS=3 — easy to swap).
