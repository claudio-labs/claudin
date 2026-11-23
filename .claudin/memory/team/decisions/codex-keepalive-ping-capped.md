---
name: codex-keepalive-ping-capped
description: Since 2026-11-23 the keep-alive ping on the ChatGPT Codex backend carries max_output_tokens (16) through a shim adapter method; Copilot GPT-5+ and other Responses hosts get no ping; Anthropic SDK clients ping exactly as before
type: project
scope: agent/cache/keepAlive
impact: functional
---

**Decision:** a transport adapter decides the keep-alive ping. `OpenAIShimMessages.keepAlivePingParams`
(`openaiShim/messagesClient.ts`) delegates to `codexKeepAlivePingParams`
(`src/providers/shims/codex/backend.ts`), and `armKeepAlive` uses it when the client has it:
- **Chat Completions:** the body as it is, because it already caps `max_tokens`.
- **The Codex backend:** the body marked `codexHonorMaxTokens`, which `performCodexRequest` turns into
  `max_output_tokens: max(16, max_tokens)`.
- **Any other Responses host:** null, so no ping is armed. That covers Copilot GPT-5+ and
  `codex_responses` with a custom baseUrl.

**Why:**
- `should1hCacheTTL` is false outside firstParty/vertex, so every Codex request armed a ping.
- The Responses body drops `max_tokens`, so each ping re-ran the last request with full reasoning,
  every 4.5 min for up to 30 min idle.
- Turning it off was the first choice. Then the 11-23 probes showed the quota weighs cached input at
  ~1/7: a cold request costs ~2.4% of a free window, a warm one ~0.45%. That makes the warm cache
  worth keeping.
- The backend accepted `max_output_tokens: 16` live and answered `response.incomplete`, which the
  shim's non-stream path already reads as final.
- Copilot bills each request and was never probed for the cap.

**What changes for a teammate:**
- The Anthropic path is structural: the SDK clients have no `keepAlivePingParams`, and
  `keepAlive.test.ts` pins that for Anthropic, Bedrock and Vertex. `streaming.ts` was not touched.
- A new transport whose wire ignores `max_tokens` needs the same method.
- Open: the backend's usage reports `cache_write_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens`.
  If its default tier is 30 min, the 4.5-min cadence (built for Anthropic's 5m) pings ~6× more than
  needed. A 1.3k-token probe wrote nothing it reported, so the tier is unmeasured.
- Live 2026-11-23, `claudindev` REPL on the backend over the WebSocket: the ping went out at 4.5 min as
  a full frame and read 29184 cached of ~30k, created 0, $0.0041. The first cold turn cost $0.0373.
  The prompt ("reply with just: ok") was too short for the cap to show in the output count. That the cap
  is on the frame comes from the code: the same body goes to `requestOverCodexSocket`.
- Evidence: `scripts/migrations/probes/codexKeepAlivePingCap.json` (10 probes red, 2 controls green).
  Details in [[codex-0.162-wire-diff]].
