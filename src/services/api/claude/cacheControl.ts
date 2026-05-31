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

export function should1hCacheTTL(_querySource?: QuerySource): boolean {
  const provider = getAPIProvider();

  if (
    provider === "bedrock" &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true;
  }

  if (provider !== "firstParty" && provider !== "vertex") return false;
  // Always use 1h on first-party/vertex (matches Claude Code). The previous
  // >8k *system-prompt* gate measured the wrong thing: claudio's system prompt
  // is ~3.4k so it never qualified, leaving 1h effectively dead and the cached
  // prefix expiring at 5m (re-written on any pause >5m). The real cached prefix
  // (system + ~9-20k of tools + file content) is always large enough that the
  // 2x write surcharge amortizes against avoided re-writes across a session.
  return true;
}
