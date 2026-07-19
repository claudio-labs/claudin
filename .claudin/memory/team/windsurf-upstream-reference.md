---
name: Windsurf upstream reference repo
description: Sibling repo opencode-windsurf-auth holds the reverse-engineered Windsurf cloud wire format, OAuth flow, and proto field tags that Claudin's port mirrors
type: reference
---

The sibling checkout `../opencode-windsurf-auth/` is the upstream reference Claudin's `src/services/api/windsurf/` was ported from. When a Windsurf wire-format question comes up, check it before guessing.

Where to look inside that repo:
- `src/cloud-direct/{chat.ts,wire.ts,auth.ts,metadata.ts,catalog.ts}` — Connect-RPC encoder, proto field tags, EOS-trailer handling, two-token auth.
- `src/oauth/{login.ts,register-user.ts,types.ts}` — loopback Firebase OAuth, RegisterUser → api_key exchange.
- `docs/CLOUD_DIRECT.md` — captured-body table with proto field numbers (1/3/7/8/10/16/21/22 on the request side; 3/5/6/9/28 on the response), the "Connect-Content-Encoding: gzip → opaque 200" trap, two-step auth handshake.
- `docs/OAUTH.md` — `GetSelfDevinSessionToken` fallback for api_keys missing the `devin-session-token$` prefix.

Both repos must stay in sync on: source-3 system collapse with `<system>...</system>` wrapping, pinned `WINDSURF_VERSION_STRING='2.0.0'` + `ide_name/extension_name/ide_type='windsurf'` metadata, stop-reason table (STOP_PATTERN=2 vs MAX_TOKENS=3 — easy to swap).
