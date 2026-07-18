# Kimi Code — wire format (empirical capture, 2026-07-18)

Captured from the official CLI `@moonshot-ai/kimi-code@0.27.0` (`kimi`) via mitmproxy
against the user's own subscription. **No secrets in this file** — tokens/device-id
redacted. This is the ground truth for a Claudin `/provider` preset.

## Verdict: OpenAI Chat Completions, NOT Anthropic
The subscription (device-flow login) uses the **OpenAI-compatible** endpoint with a
Bearer token. It uses the official OpenAI JS SDK (`X-Stainless-*` headers, `openai@6.34.0`).
No `/v1/messages`, no `x-api-key`. → Claudin's existing `openai_compat` transport is correct.

## OAuth device-code flow (RFC 8628) — host `auth.kimi.com`
All requests carry the `X-Msh-*` headers below (device-id generated before login).

1. **Device authorization** — `POST https://auth.kimi.com/api/oauth/device_authorization`
   - `Content-Type: application/x-www-form-urlencoded`, body: `client_id=<CLIENT_ID>`
   - 200 → `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in:1800, interval:5 }`
   - `verification_uri_complete` = `https://www.kimi.com/code/authorize_device?user_code=XXXX-XXXX` (open in browser)
2. **Token poll** — `POST https://auth.kimi.com/api/oauth/token`
   - body: `client_id=<CLIENT_ID>&device_code=<dc>&grant_type=urn:ietf:params:oauth:grant-type:device_code`
   - 400 `{"error":"authorization_pending"}` on `interval` until approved
   - 200 → `{ access_token, refresh_token, token_type:"Bearer", expires_in:900, scope:"kimi-code" }`
   - **access_token lives 900s (15 min)** → must refresh proactively / on 401.
3. **Refresh** — `POST https://auth.kimi.com/api/oauth/token`
   - body: `client_id=<CLIENT_ID>&grant_type=refresh_token&refresh_token=<rt>`
   - 401 `{"error":"invalid_grant","error_description":"The device associated with the refresh token has been revoked"}` if the device was revoked → re-login.

**client_id (public, hardcoded in the CLI):** `17e5f671-d194-4dfb-9706-5516cb48c098`

## Coding API — host `api.kimi.com`, base `/coding/v1`
- `GET  /coding/v1/models`            → OpenAI-style `{data:[{id, context_length, ...}]}`
- `POST /coding/v1/chat/completions`  → OpenAI Chat Completions (SSE stream)

### Required request headers (both auth + coding hosts)
```
Authorization: Bearer <access_token>          (coding host only; auth host omits it)
User-Agent: kimi-code-cli/0.27.0              (coding host)  |  auth host sent UA "node"
X-Msh-Platform: kimi_code_cli                 ← accepted, returns 200 (research's "kimi_cli-only" claim was WRONG)
X-Msh-Version: 0.27.0
X-Msh-Device-Name: <hostname>                 e.g. viudes-arch
X-Msh-Device-Model: <os> <arch>              e.g. "Linux 6.18.38-2-lts x64"
X-Msh-Os-Version: <kernel/os version>
X-Msh-Device-Id: <stable UUID, 36 chars>      generated once, persisted
```
Missing `X-Msh-*` → 401/403. `X-Msh-Platform=kimi_code_cli` is the correct accepted value.

### chat/completions request body (top-level keys observed)
```
model: "kimi-for-coding"        (or kimi-for-coding-highspeed | k3)
messages: [...]                 OpenAI roles (system, user, assistant, tool)
stream: true
stream_options: {...}
tools: [...]                    OpenAI function-calling (26 in the CLI)
max_completion_tokens: <n>      NB: OpenAI newer field, not max_tokens
prompt_cache_key: <str>         OpenAI prompt-cache hint
thinking: { type:"enabled", keep:"all" }   ← Kimi extension for reasoning
```

### K3 thinking-effort levels
The `k3` model exposes three thinking-effort levels controlled by the
`thinking.effort` field. Captured by varying `default_effort` in the CLI's
`config.toml` and issuing `kimi -m kimi-code/k3 --prompt hi`:

| UI label | `thinking.effort` | Observed body snippet |
|----------|-------------------|-----------------------|
| Low      | `low`             | `{"thinking":{"type":"enabled","effort":"low","keep":"all"}}` |
| High     | `high`            | `{"thinking":{"type":"enabled","effort":"high","keep":"all"}}` |
| Max      | `max`             | `{"thinking":{"type":"enabled","effort":"max","keep":"all"}}` |

The non-K3 models (`kimi-for-coding`, `kimi-for-coding-highspeed`) support
`thinking: { type:"enabled", keep:"all" }` as an on/off toggle only.

Response SSE deltas carry `reasoning_content` (Kimi/DeepSeek-style) alongside `content`.

### Model catalog (`GET /coding/v1/models`, 200)
| id | context_length | display | flags |
|----|---------------:|---------|-------|
| `kimi-for-coding`           | 262144  | K2.7 Coding           | thinking=only, image, video, reasoning |
| `kimi-for-coding-highspeed` | 262144  | K2.7 Coding Highspeed | idem |
| `k3`                        | 1048576 | K3                    | idem |

Native model id for the 1M model is **`k3`** (the `k3[1m]` in Kimi's third-party docs is
Claude-Code notation). `/models` reports `context_length` directly → Claudin's OpenAI-shim
`/models` discovery picks up the window with no hardcoding.

## Notes for a Claudin implementation
- Transport: **openai_compat** (existing `kimi-code` preset base URL `https://api.kimi.com/coding/v1` is correct).
- Auth: OAuth device-flow (own credential store + own generated device UUID; do NOT reuse the CLI's).
- Header injection point: the OpenAI shim request path (`openaiShim/messagesClient.ts`).
- Refresh: 900s access token → refresh on 401 / near-expiry (`withRetry.ts`).
- Shipping caveat: sending `User-Agent: kimi-code-cli` + `X-Msh-Platform: kimi_code_cli`
  makes Claudin indistinguishable from the official CLI (user's own token/account, but
  presents as the first-party client — a gray area).
