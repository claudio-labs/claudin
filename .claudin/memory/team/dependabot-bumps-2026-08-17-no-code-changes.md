---
name: dependabot-bumps-2026-08-17-no-code-changes
description: Audit of PRs #109/#110 (Anthropic SDK 0.115→0.117.1 + 5 others) — no code changes needed; why the SDK's new hardcoded User-Agent is inert for the fork
type: project
---

Dependabot batch merged 2026-08-17 (#110 production: `@anthropic-ai/sdk`
0.115.0→0.117.1, bedrock-sdk 0.32.4, vertex-sdk 0.19.4, foundry-sdk 0.4.3,
firecrawl-js 4.32.1, google-auth-library 11.0.2; #109 dev: `@types/node`
26.2.0, knip 6.32.2). Audited after `bun install`: typecheck 0, build OK,
smoke OK, `verify:privacy` + `verify:sdk-types` pass, knip reports only
pre-existing config hints, full suite 9299 passed / 87 skipped. **No source
change required.**

Two changelog entries looked like they touched this fork and did not:

- **SDK 0.116 "use hardcoded User-Agent strings instead of constructor names"**
  is inert here. `BaseAnthropic.buildHeaders` (`node_modules/@anthropic-ai/sdk/client.mjs:825-842`)
  applies `this._options.defaultHeaders` *after* its own `'User-Agent': this.getUserAgent()`,
  and `getAnthropicClient` (`src/providers/transport/client.ts:115-132`) puts
  `buildIdentityHeaders(...)` in `defaultHeaders`, so Claudin's identity still
  wins on every lane. The SDK's own UA is now `Anthropic/JS <version>` per
  package instead of derived from the subclass name — either way it never
  reaches the wire. Related: [[defingerprinting-branch-2026-08]].
- **SDK 0.117 "apply all message_delta fields when accumulating streamed
  messages"** describes a bug the fork does not share in any reachable way.
  `applyMessageDeltaToLastMessage` (`src/providers/shims/claude/streaming.ts:2361`)
  persists `usage`, `stop_reason` and `context_management` but not
  `stop_sequence`/`stop_details` — refusal handling reads `part.delta.stop_details`
  straight off the event (`streaming.ts:1616`), and nothing reads
  `message.stop_sequence`, so this is transcript fidelity only and predates the bump.

**Why:** the next Anthropic-SDK bump will raise the same two questions; the
header-precedence line is the durable answer.

**How to apply:** `node_modules` is not refreshed by the merge — check the
installed versions against `package.json` and run plain `bun install` first
(see [[incremental-bun-install-misses-nested-deps]]), otherwise every green
check is measuring the old tree.
