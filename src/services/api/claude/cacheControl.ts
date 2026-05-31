import { getLargeSystemPromptDetected } from "src/bootstrap/state.js";
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
  return getLargeSystemPromptDetected() === true;
}
