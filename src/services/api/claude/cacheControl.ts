import type { QuerySource } from "src/constants/querySource.js";
import type { CacheScope } from "src/utils/api.js";
import { isEnvTruthy } from "src/utils/envUtils.js";
import { getAPIProvider } from "src/utils/model/providers.js";

export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope;
  querySource?: QuerySource;
} = {}): {
  type: "ephemeral";
  ttl?: "1h";
  scope?: CacheScope;
} {
  return {
    type: "ephemeral",
    ...(should1hCacheTTL(querySource) && { ttl: "1h" }),
    ...(scope === "global" && { scope }),
  };
}

// Fork children share the PARENT's prefix — their markers must keep the
// parent's 1h TTL, or a fork request would re-cache the main thread's
// line at the 5m tier and expire it under the parent.
const FORK_QUERY_SOURCE = "agent:builtin:fork";
const SUBAGENT_QUERY_SOURCE_PREFIX = "agent:";

// One-shot / short-lived utility queries that build a FRESH prefix of their
// own (own system prompt, own line — never re-caching the main thread's).
// Their cache dies with the call, so the 5m tier is strictly cheaper.
// Deliberately NOT here (they fork the main thread's prefix and must keep
// its 1h TTL): compact, session_memory, extract_memories, speculation,
// prompt_suggestion, side_question, magic_docs, auto_dream.
// Also NOT here: auto_mode — the yoloClassifier caches system + a serialized
// transcript that GROWS with the session and fires on every tool call
// (yoloClassifier.ts ~1250). It behaves like a mini main thread: under 5m,
// every >5min user pause expires the transcript-sized prefix and forces a
// full 1.25x rewrite; under 1h only the small per-call tail writes at 2x.
const SHORT_LIVED_QUERY_SOURCES: ReadonlySet<string> = new Set([
  "tool_use_summary_generation",
  "web_search_tool",
  "agent_creation",
  "skill_improvement_apply",
  "hook_prompt",
  "hook_agent",
  "bash_extract_prefix",
  // agent_summary forks the SUBAGENT's prefix (not the main thread's) —
  // subagents are 5m now, so its markers must match at 5m, not re-cache
  // the subagent's line at the 2x 1h write price.
  "agent_summary",
  // away_summary re-sends parent messages but with empty system + no tools,
  // so its prefix diverges at byte 0 — own line, short-lived.
  "away_summary",
]);

export function should1hCacheTTL(querySource?: QuerySource): boolean {
  const provider = getAPIProvider();

  if (
    provider === "bedrock" &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true;
  }

  if (provider !== "firstParty" && provider !== "vertex") return false;

  // Subagents (agent:builtin:Explore, agent:custom, …) are short-lived and
  // their cache dies with them: reads refresh the 5m TTL for free within a
  // run, so the 5m tier (1.25x write) beats 1h (2x write) unless the agent
  // idles >5min mid-run — rare for read-only search/research agents. The
  // fork child is the one exception (shares the parent's prefix, see above).
  if (
    querySource?.startsWith(SUBAGENT_QUERY_SOURCE_PREFIX) &&
    querySource !== FORK_QUERY_SOURCE
  ) {
    return false;
  }

  // Same economics for the one-shot utility queries with fresh prefixes.
  if (querySource && SHORT_LIVED_QUERY_SOURCES.has(querySource)) {
    return false;
  }

  // Always use 1h on first-party/vertex (matches Claude Code). The previous
  // >8k *system-prompt* gate measured the wrong thing: claudin's system prompt
  // is ~3.4k so it never qualified, leaving 1h effectively dead and the cached
  // prefix expiring at 5m (re-written on any pause >5m). The real cached prefix
  // (system + ~9-20k of tools + file content) is always large enough that the
  // 2x write surcharge amortizes against avoided re-writes across a session.
  return true;
}
