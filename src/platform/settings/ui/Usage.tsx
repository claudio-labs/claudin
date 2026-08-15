import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useEffect, useReducer, useState } from 'react';
import { extraUsage as extraUsageCommand } from 'src/commands/extra-usage/index.js';
import { formatCost, getModelUsage, getProjectTotals, getTotalAPIDuration, getTotalCost, getTotalDuration, getTotalLinesAdded, getTotalLinesRemoved, hasUnknownModelCost } from 'src/agent/cost-tracker.js';
import { getCanonicalName } from 'src/utils/model/model.js';
import { formatDuration, formatNumber, formatTokens } from 'src/shared/text/format.js';
import { getBytesSaved } from 'src/agent/context/tokensSaved.js';
import { BYTES_PER_TOKEN } from 'src/constants/toolLimits.js';
import { getSubscriptionType } from 'src/services/auth/auth.js';
import chalk from 'chalk';
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js';
import { Box, RawAnsi, Text, useTheme } from 'src/terminal/ink.js';
import { colorize } from 'src/terminal/ink/colorize.js';
import { useModalOrTerminalSize } from 'src/terminal/contexts/modalContext.js';
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js';
import { type ExtraUsage, fetchUtilization, type RateLimit, type Utilization } from 'src/services/api/usage.js';
import { formatResetText } from 'src/shared/text/format.js';
import { logError } from 'src/shared/log.js';
import { getAPIProvider } from 'src/utils/model/providers.js';
import { jsonStringify } from 'src/platform/slowOperations.js';
import { ConfigurableShortcutHint } from 'src/terminal/ConfigurableShortcutHint.js';
import { Byline } from 'src/terminal/design-system/Byline.js';
import { ProgressBar } from 'src/terminal/design-system/ProgressBar.js';
import { isEligibleForOverageCreditGrant, OverageCreditUpsell } from 'src/terminal/logo/OverageCreditUpsell.js';
import { CodexUsage } from 'src/platform/settings/ui/CodexUsage.js';
import { MiniMaxUsage } from 'src/platform/settings/ui/MiniMaxUsage.js';
import { UnsupportedUsage } from 'src/platform/settings/ui/UnsupportedUsage.js';
import { computeUsageContribution, type ContributionResult, type UsageWindow } from 'src/platform/usageContribution/usageContribution.js';
type LimitBarProps = {
  title: string;
  limit: RateLimit;
  maxWidth: number;
  showTimeInReset?: boolean;
  extraSubtext?: string;
};
function LimitBar(t0: LimitBarProps) {
  const $ = _c(34);
  const {
    title,
    limit,
    maxWidth,
    showTimeInReset: t1,
    extraSubtext
  } = t0;
  const showTimeInReset = t1 === undefined ? true : t1;
  const {
    utilization,
    resets_at
  } = limit;
  if (utilization === null) {
    return null;
  }
  const usedText = `${Math.floor(utilization)}% used`;
  let subtext;
  if (resets_at) {
    let t2;
    if ($[0] !== resets_at || $[1] !== showTimeInReset) {
      t2 = formatResetText(resets_at, true, showTimeInReset);
      $[0] = resets_at;
      $[1] = showTimeInReset;
      $[2] = t2;
    } else {
      t2 = $[2];
    }
    subtext = `Resets ${t2}`;
  }
  if (extraSubtext) {
    if (subtext) {
      subtext = `${extraSubtext} · ${subtext}`;
    } else {
      subtext = extraSubtext;
    }
  }
  if (maxWidth >= 62) {
    let t2;
    if ($[3] !== title) {
      t2 = <Text bold={true}>{title}</Text>;
      $[3] = title;
      $[4] = t2;
    } else {
      t2 = $[4];
    }
    const t3 = utilization / 100;
    let t4;
    if ($[5] !== t3) {
      t4 = <ProgressBar ratio={t3} width={50} fillColor="rate_limit_fill" emptyColor="rate_limit_empty" />;
      $[5] = t3;
      $[6] = t4;
    } else {
      t4 = $[6];
    }
    let t5;
    if ($[7] !== usedText) {
      t5 = <Text>{usedText}</Text>;
      $[7] = usedText;
      $[8] = t5;
    } else {
      t5 = $[8];
    }
    let t6;
    if ($[9] !== t4 || $[10] !== t5) {
      t6 = <Box flexDirection="row" gap={1}>{t4}{t5}</Box>;
      $[9] = t4;
      $[10] = t5;
      $[11] = t6;
    } else {
      t6 = $[11];
    }
    let t7;
    if ($[12] !== subtext) {
      t7 = subtext && <Text dimColor={true}>{subtext}</Text>;
      $[12] = subtext;
      $[13] = t7;
    } else {
      t7 = $[13];
    }
    let t8;
    if ($[14] !== t2 || $[15] !== t6 || $[16] !== t7) {
      t8 = <Box flexDirection="column">{t2}{t6}{t7}</Box>;
      $[14] = t2;
      $[15] = t6;
      $[16] = t7;
      $[17] = t8;
    } else {
      t8 = $[17];
    }
    return t8;
  } else {
    let t2;
    if ($[18] !== title) {
      t2 = <Text bold={true}>{title}</Text>;
      $[18] = title;
      $[19] = t2;
    } else {
      t2 = $[19];
    }
    let t3;
    if ($[20] !== subtext) {
      t3 = subtext && <><Text> </Text><Text dimColor={true}>· {subtext}</Text></>;
      $[20] = subtext;
      $[21] = t3;
    } else {
      t3 = $[21];
    }
    let t4;
    if ($[22] !== t2 || $[23] !== t3) {
      t4 = <Text>{t2}{t3}</Text>;
      $[22] = t2;
      $[23] = t3;
      $[24] = t4;
    } else {
      t4 = $[24];
    }
    const t5 = utilization / 100;
    let t6;
    if ($[25] !== maxWidth || $[26] !== t5) {
      t6 = <ProgressBar ratio={t5} width={maxWidth} fillColor="rate_limit_fill" emptyColor="rate_limit_empty" />;
      $[25] = maxWidth;
      $[26] = t5;
      $[27] = t6;
    } else {
      t6 = $[27];
    }
    let t7;
    if ($[28] !== usedText) {
      t7 = <Text>{usedText}</Text>;
      $[28] = usedText;
      $[29] = t7;
    } else {
      t7 = $[29];
    }
    let t8;
    if ($[30] !== t4 || $[31] !== t6 || $[32] !== t7) {
      t8 = <Box flexDirection="column">{t4}{t6}{t7}</Box>;
      $[30] = t4;
      $[31] = t6;
      $[32] = t7;
      $[33] = t8;
    } else {
      t8 = $[33];
    }
    return t8;
  }
}
function AnthropicUsage(): React.ReactNode {
  const [utilization, setUtilization] = useState<Utilization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const {
    columns
  } = useTerminalSize();
  const availableWidth = columns - 2; // 2 for screen padding
  const maxWidth = Math.min(availableWidth, 80);
  const loadUtilization = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchUtilization();
      setUtilization(data);
    } catch (err) {
      logError(err as Error);
      const axiosError = err as {
        response?: {
          data?: unknown;
          status?: number;
        };
      };
      const data = axiosError.response?.data as { error?: { type?: string; message?: string } } | undefined;
      const status = axiosError.response?.status;
      let friendly: string;
      if (data?.error?.type === 'rate_limit_error') {
        friendly = data.error.message || 'Rate limited. Please try again later.';
      } else if (data?.error?.message) {
        friendly = data.error.message;
      } else if (status) {
        friendly = `HTTP ${status} — ${jsonStringify(axiosError.response?.data ?? {})}`;
      } else {
        friendly = (err as Error)?.message || 'Failed to load usage data';
      }
      setError(friendly);
    } finally {
      setIsLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadUtilization();
  }, [loadUtilization]);
  useKeybinding('settings:retry', () => {
    void loadUtilization();
  }, {
    context: 'Settings',
    isActive: !!error && !isLoading
  });
  if (error) {
    return <Box flexDirection="column" gap={1}>
        <Text color="error">Could not load Anthropic rate-limit data: {error}</Text>
        <Text dimColor>(cost/usage totals above are unaffected)</Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint action="settings:retry" context="Settings" fallback="r" description="retry" />
            <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
          </Byline>
        </Text>
      </Box>;
  }
  if (!utilization) {
    return <Box flexDirection="column" gap={1}>
        <Text dimColor>Loading usage data…</Text>
        <Text dimColor>
          <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
        </Text>
      </Box>;
  }

  // Only Max and Team plans have a Sonnet limit that differs from the weekly
  // limit (see rateLimitMessages.ts). For other plans the bar is redundant.
  // Show for null (unknown plan) to stay consistent with rateLimitMessages.ts,
  // which labels it "Sonnet limit" in that case.
  const subscriptionType = getSubscriptionType();
  const showSonnetBar = subscriptionType === 'max' || subscriptionType === 'team' || subscriptionType === null;
  const limits = [{
    title: 'Current session',
    limit: utilization.five_hour
  }, {
    title: 'Current week (all models)',
    limit: utilization.seven_day
  }, ...(showSonnetBar ? [{
    title: 'Current week (Sonnet only)',
    limit: utilization.seven_day_sonnet
  }] : [])];
  return <Box flexDirection="column" gap={1} width="100%">
      {limits.some(({
      limit
    }) => limit) || <Text dimColor>/usage is only available for subscription plans.</Text>}

      {limits.map(({
      title,
      limit: limit_0
    }) => limit_0 && <LimitBar key={title} title={title} limit={limit_0} maxWidth={maxWidth} />)}

      {utilization.extra_usage && <ExtraUsageSection extraUsage={utilization.extra_usage} maxWidth={maxWidth} />}

      {isEligibleForOverageCreditGrant() && <OverageCreditUpsell maxWidth={maxWidth} />}

      <Text dimColor>
        <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
      </Text>
    </Box>;
}
type ModelUsageLite = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
};

function CostStatsBlock(props: {
  title: string;
  totalCost: number;
  apiDuration: number;
  wallDuration: number;
  linesAdded: number;
  linesRemoved: number;
  modelUsage: Record<string, ModelUsageLite>;
  unknownCost?: boolean;
  bytesSaved?: number;
}): React.ReactNode {
  const { title, totalCost, apiDuration, wallDuration, linesAdded, linesRemoved, modelUsage, unknownCost, bytesSaved } = props;
  const modelEntries = Object.entries(modelUsage);
  if (totalCost === 0 && modelEntries.length === 0 && linesAdded === 0 && linesRemoved === 0) {
    return null;
  }

  // Mirror formatModelUsage: accumulate per canonical short name so duplicate
  // model IDs (e.g. dated variants) collapse into a single line.
  const usageByShortName: Record<string, ModelUsageLite> = {};
  for (const [model, usage] of modelEntries) {
    const shortName = getCanonicalName(model);
    if (!usageByShortName[shortName]) {
      usageByShortName[shortName] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0
      };
    }
    const acc = usageByShortName[shortName];
    acc.inputTokens += usage.inputTokens;
    acc.outputTokens += usage.outputTokens;
    acc.cacheReadInputTokens += usage.cacheReadInputTokens;
    acc.cacheCreationInputTokens += usage.cacheCreationInputTokens;
    acc.webSearchRequests += usage.webSearchRequests;
    acc.costUSD += usage.costUSD;
  }
  const aggregated = Object.entries(usageByShortName);

  return <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text>
        <Text>Total cost:            </Text>
        <Text>{formatCost(totalCost)}</Text>
        {unknownCost && <Text dimColor> (costs may be inaccurate due to usage of unknown models)</Text>}
      </Text>
      <Text>Total duration (API):  {formatDuration(apiDuration)}</Text>
      <Text>Total duration (wall): {formatDuration(wallDuration)}</Text>
      <Text>
        Total code changes:    {linesAdded} {linesAdded === 1 ? 'line' : 'lines'} added, {linesRemoved} {linesRemoved === 1 ? 'line' : 'lines'} removed
      </Text>
      {bytesSaved !== undefined && bytesSaved > 0 && (
        <Text>Context tokens saved:  ~{formatTokens(bytesSaved / BYTES_PER_TOKEN)} tokens</Text>
      )}
      {aggregated.length > 0 && <Text>Usage by model:</Text>}
      {aggregated.map(([shortName, usage]) => {
        let line = `${formatNumber(usage.inputTokens)} input, ${formatNumber(usage.outputTokens)} output`;
        if (usage.cacheReadInputTokens > 0) {
          line += `, ${formatNumber(usage.cacheReadInputTokens)} cache read`;
        }
        if (usage.cacheCreationInputTokens > 0) {
          line += `, ${formatNumber(usage.cacheCreationInputTokens)} cache write`;
        }
        if (usage.webSearchRequests > 0) {
          line += `, ${formatNumber(usage.webSearchRequests)} web search`;
        }
        line += ` (${formatCost(usage.costUSD)})`;
        return <Text key={shortName}>{`${shortName}:`.padStart(21)} {line}</Text>;
      })}
    </Box>;
}

type CostView = 'global' | 'session';

export function SessionCostStats(props: { view?: CostView } = {}): React.ReactNode {
  const view: CostView = props.view ?? 'global';
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const interval = setInterval(() => tick(), 1000);
    return () => clearInterval(interval);
  }, []);

  const unknownCost = hasUnknownModelCost();

  if (view === 'session') {
    const sessionCost = getTotalCost();
    const sessionModelUsage = getModelUsage();
    const sessionLinesAdded = getTotalLinesAdded();
    const sessionLinesRemoved = getTotalLinesRemoved();
    return <CostStatsBlock
      title="Current session"
      totalCost={sessionCost}
      apiDuration={getTotalAPIDuration()}
      wallDuration={getTotalDuration()}
      linesAdded={sessionLinesAdded}
      linesRemoved={sessionLinesRemoved}
      modelUsage={sessionModelUsage}
      unknownCost={unknownCost}
      bytesSaved={getBytesSaved()}
    />;
  }

  const projectTotals = getProjectTotals();
  const hasProjectData = projectTotals.totalCost !== 0 || Object.keys(projectTotals.modelUsage).length > 0 || projectTotals.totalLinesAdded !== 0 || projectTotals.totalLinesRemoved !== 0;
  if (!hasProjectData) return null;
  return <Box flexDirection="column" gap={1}>
      <CostStatsBlock
        title="Project total (all sessions)"
        totalCost={projectTotals.totalCost}
        apiDuration={projectTotals.totalAPIDuration}
        wallDuration={projectTotals.totalDuration}
        linesAdded={projectTotals.totalLinesAdded}
        linesRemoved={projectTotals.totalLinesRemoved}
        modelUsage={projectTotals.modelUsage}
        unknownCost={unknownCost}
      />
      <Text dimColor>Aggregated across all sessions in this project — includes the current session live.</Text>
    </Box>;
}
export function Usage(props: { view?: CostView } = {}): React.ReactNode {
  const view: CostView = props.view ?? 'global';
  if (view === 'session') {
    return <Box flexDirection="column" gap={1} width="100%">
        <SessionCostStats view="session" />
      </Box>;
  }
  const provider = getAPIProvider();
  // Anthropic (firstParty) is the common, tall case (project totals + limit
  // bars + contribution) — render it in a scroll pane so it never overflows
  // the Settings viewport in inline mode. Other providers keep the simple
  // non-scroll layout (their usage panels are short).
  if (provider === 'firstParty') {
    return <UsageGlobalScroll />;
  }
  let providerView: React.ReactNode;
  if (provider === 'codex') {
    providerView = <CodexUsage />;
  } else if (provider === 'minimax') {
    providerView = <MiniMaxUsage />;
  } else {
    // firstParty already returned above (scroll pane); everything else here is
    // an unsupported-usage provider.
    const providerLabel = {
      openai: 'this OpenAI-compatible provider',
      gemini: 'Google Gemini',
      github: 'GitHub Copilot',
      mistral: 'Mistral',
      'nvidia-nim': 'NVIDIA NIM',
      bedrock: 'AWS Bedrock',
      vertex: 'Google Vertex AI',
      foundry: 'Microsoft Foundry'
    }[provider] ?? 'this provider';
    providerView = <UnsupportedUsage providerLabel={providerLabel} />;
  }
  return <Box flexDirection="column" gap={1} width="100%">
      <SessionCostStats view="global" />
      {providerView}
      <UsageContribution />
    </Box>;
}

const CONTRIBUTION_ADVICE =
  'Each subagent runs its own requests. Be deliberate about spawning them — and consider a cheaper model for simpler subagents.';

/**
 * "What's driving your token usage?" — provider-agnostic, local-only analysis
 * of which sessions/subagents drove recent token usage. Data comes from
 * computeUsageContribution() (scans local transcripts); nothing is sent out.
 */
function UsageContribution(): React.ReactNode {
  const [activeWindow, setActiveWindow] = useState<UsageWindow>('day');
  const [result, setResult] = useState<ContributionResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = React.useCallback(async (w: UsageWindow) => {
    setIsLoading(true);
    try {
      setResult(await computeUsageContribution(w));
    } catch (err) {
      logError(err as Error);
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(activeWindow);
  }, [load, activeWindow]);

  useKeybinding('settings:usageDay', () => setActiveWindow('day'), {
    context: 'Settings',
    isActive: true,
  });
  useKeybinding('settings:usageWeek', () => setActiveWindow('week'), {
    context: 'Settings',
    isActive: true,
  });

  const windowLabel = activeWindow === 'day' ? 'last 24h' : 'last week';
  const topAgent = result?.agentBreakdown[0];

  return (
    <Box flexDirection="column" width="100%">
      <Text bold>What's driving your token usage?</Text>
      <Text dimColor>
        Approximate, based on local sessions on this machine — does not include
        other devices.
      </Text>
      <Text dimColor>
        {`${windowLabel[0]!.toUpperCase()}${windowLabel.slice(1)} · a characteristic of your usage, not a full breakdown`}
      </Text>

      {isLoading && !result ? (
        <Text dimColor>Analyzing local sessions…</Text>
      ) : !result || result.totalTokens === 0 ? (
        <Text dimColor>{`No local session activity in the ${windowLabel}.`}</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {result.subagentHeavyPct >= 5 && (
            <Box flexDirection="column">
              <Text>
                {`${Math.round(result.subagentHeavyPct)}% of your token usage came from subagent-heavy sessions.`}
              </Text>
              <Text dimColor>{CONTRIBUTION_ADVICE}</Text>
            </Box>
          )}
          {topAgent && (
            <Box flexDirection="column" marginTop={result.subagentHeavyPct >= 5 ? 1 : 0}>
              <Text>
                {`${Math.round(topAgent.pct)}% of your token usage came from subagents under '${topAgent.agentType}'.`}
              </Text>
            </Box>
          )}
          {result.agentBreakdown.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text>
                <Text>{'Subagents'.padEnd(24)}</Text>
                <Text>% of usage</Text>
              </Text>
              {result.agentBreakdown.map(a => (
                <Text key={a.agentType}>
                  <Text>{a.agentType.padEnd(24)}</Text>
                  <Text>{`${Math.round(a.pct)}%`}</Text>
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      <Text dimColor>d to day · w to week</Text>
    </Box>
  );
}
type ExtraUsageSectionProps = {
  extraUsage: ExtraUsage;
  maxWidth: number;
};
const EXTRA_USAGE_SECTION_TITLE = 'Extra usage';
function ExtraUsageSection(t0: ExtraUsageSectionProps) {
  const $ = _c(20);
  const {
    extraUsage,
    maxWidth
  } = t0;
  const subscriptionType = getSubscriptionType();
  const isProOrMax = subscriptionType === "pro" || subscriptionType === "max";
  if (!isProOrMax) {
    return false;
  }
  if (!extraUsage.is_enabled) {
    if (extraUsageCommand.isEnabled()) {
      let t1;
      if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
        t1 = <Box flexDirection="column"><Text bold={true}>{EXTRA_USAGE_SECTION_TITLE}</Text><Text dimColor={true}>Extra usage not enabled · /extra-usage to enable</Text></Box>;
        $[0] = t1;
      } else {
        t1 = $[0];
      }
      return t1;
    }
    return null;
  }
  if (extraUsage.monthly_limit === null) {
    let t1;
    if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = <Box flexDirection="column"><Text bold={true}>{EXTRA_USAGE_SECTION_TITLE}</Text><Text dimColor={true}>Unlimited</Text></Box>;
      $[1] = t1;
    } else {
      t1 = $[1];
    }
    return t1;
  }
  if (typeof extraUsage.used_credits !== "number" || typeof extraUsage.utilization !== "number") {
    return null;
  }
  const t1 = extraUsage.used_credits / 100;
  let t2;
  if ($[2] !== t1) {
    t2 = formatCost(t1, 2);
    $[2] = t1;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const formattedUsedCredits = t2;
  const t3 = extraUsage.monthly_limit / 100;
  let t4;
  if ($[4] !== t3) {
    t4 = formatCost(t3, 2);
    $[4] = t3;
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  const formattedMonthlyLimit = t4;
  let T0;
  let t5;
  let t6;
  let t7;
  if ($[6] !== extraUsage.utilization) {
    const now = new Date();
    const oneMonthReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    T0 = LimitBar;
    t7 = EXTRA_USAGE_SECTION_TITLE;
    t5 = extraUsage.utilization;
    t6 = oneMonthReset.toISOString();
    $[6] = extraUsage.utilization;
    $[7] = T0;
    $[8] = t5;
    $[9] = t6;
    $[10] = t7;
  } else {
    T0 = $[7];
    t5 = $[8];
    t6 = $[9];
    t7 = $[10];
  }
  let t8;
  if ($[11] !== t5 || $[12] !== t6) {
    t8 = {
      utilization: t5,
      resets_at: t6
    };
    $[11] = t5;
    $[12] = t6;
    $[13] = t8;
  } else {
    t8 = $[13];
  }
  const t9 = `${formattedUsedCredits} / ${formattedMonthlyLimit} spent`;
  let t10;
  if ($[14] !== T0 || $[15] !== maxWidth || $[16] !== t7 || $[17] !== t8 || $[18] !== t9) {
    t10 = <T0 title={t7} limit={t8} showTimeInReset={false} extraSubtext={t9} maxWidth={maxWidth} />;
    $[14] = T0;
    $[15] = maxWidth;
    $[16] = t7;
    $[17] = t8;
    $[18] = t9;
    $[19] = t10;
  } else {
    t10 = $[19];
  }
  return t10;
}

/**
 * Scrollable global Usage view (Anthropic/firstParty). The Settings tab
 * clips content with a fixed-height Box, but in inline render mode that
 * height does not truly clip (see ink-tui.md #4), so a tall Usage tab spills
 * past the viewport. This renders the whole view as a flat string[] and
 * windows it with RawAnsi + a scroll offset (↑/↓/PgUp/PgDn), which works in
 * every render mode. Async data (rate limits, contribution) resolves in this
 * real fiber, then feeds the string builder.
 */
function UsageGlobalScroll(): React.ReactNode {
  const theme = useTheme();
  const term = useTerminalSize();
  const { columns } = term;
  const { rows } = useModalOrTerminalSize(term);
  const width = Math.min(Math.max(20, columns - 2), 80);
  const barWidth = Math.min(50, Math.max(20, width - 14));
  const cap = Math.max(15, Math.min(Math.floor(rows * 0.8), 30));
  const bodyRows = Math.max(5, cap - 3);

  const [util, setUtil] = useState<Utilization | null>(null);
  const [utilError, setUtilError] = useState<string | null>(null);
  const [utilLoading, setUtilLoading] = useState(true);
  const [contribWindow, setContribWindow] = useState<UsageWindow>('day');
  const [contrib, setContrib] = useState<ContributionResult | null>(null);
  const [contribLoading, setContribLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [, tick] = useReducer((x: number) => x + 1, 0);

  const loadUtil = React.useCallback(async () => {
    setUtilLoading(true);
    setUtilError(null);
    try {
      setUtil(await fetchUtilization());
    } catch (err) {
      logError(err as Error);
      setUtilError((err as Error)?.message || 'Failed to load usage data');
    } finally {
      setUtilLoading(false);
    }
  }, []);
  const loadContrib = React.useCallback(async (w: UsageWindow) => {
    setContribLoading(true);
    try {
      setContrib(await computeUsageContribution(w));
    } catch (err) {
      logError(err as Error);
      setContrib(null);
    } finally {
      setContribLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadUtil();
  }, [loadUtil]);
  useEffect(() => {
    void loadContrib(contribWindow);
  }, [loadContrib, contribWindow]);
  useEffect(() => {
    const id = setInterval(() => tick(), 1000);
    return () => clearInterval(id);
  }, []);

  const scrollUp = () => setOffset(o => Math.max(0, o - 1));
  const scrollDown = () => setOffset(o => o + 1);
  const pageUp = () => setOffset(o => Math.max(0, o - bodyRows));
  const pageDown = () => setOffset(o => o + bodyRows);
  const kb = { context: 'Settings' as const, isActive: true };
  useKeybinding('select:previous', scrollUp, kb);
  useKeybinding('select:next', scrollDown, kb);
  useKeybinding('scroll:lineUp', scrollUp, kb);
  useKeybinding('scroll:lineDown', scrollDown, kb);
  useKeybinding('scroll:pageUp', pageUp, kb);
  useKeybinding('scroll:pageDown', pageDown, kb);
  useKeybinding('settings:usageDay', () => setContribWindow('day'), kb);
  useKeybinding('settings:usageWeek', () => setContribWindow('week'), kb);
  useKeybinding('settings:retry', () => {
    void loadUtil();
    void loadContrib(contribWindow);
  }, { context: 'Settings', isActive: !!utilError && !utilLoading });

  const bold = (s: string) => chalk.bold(s);
  const dim = (s: string) => chalk.dim(s);
  const makeBar = (ratio: number): string => {
    const r = Math.min(1, Math.max(0, ratio));
    const whole = Math.floor(r * barWidth);
    const filled = '█'.repeat(whole);
    const empty = ' '.repeat(Math.max(0, barWidth - whole));
    return (
      colorize(filled, theme.rate_limit_fill, 'foreground') +
      colorize(empty, theme.rate_limit_empty, 'background')
    );
  };

  const lines: string[] = [];

  // ── Project totals (mirrors SessionCostStats/CostStatsBlock) ──
  const totals = getProjectTotals();
  lines.push(bold('Project total (all sessions)'));
  lines.push(
    'Total cost:            ' +
      formatCost(totals.totalCost) +
      (hasUnknownModelCost() ? dim(' (costs may be inaccurate)') : ''),
  );
  lines.push('Total duration (API):  ' + formatDuration(totals.totalAPIDuration));
  lines.push('Total duration (wall): ' + formatDuration(totals.totalDuration));
  lines.push(
    `Total code changes:    ${totals.totalLinesAdded} ${totals.totalLinesAdded === 1 ? 'line' : 'lines'} added, ${totals.totalLinesRemoved} ${totals.totalLinesRemoved === 1 ? 'line' : 'lines'} removed`,
  );
  const usageByShortName: Record<string, ModelUsageLite> = {};
  for (const [model, usage] of Object.entries(totals.modelUsage)) {
    const shortName = getCanonicalName(model);
    const acc = (usageByShortName[shortName] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
    });
    acc.inputTokens += usage.inputTokens;
    acc.outputTokens += usage.outputTokens;
    acc.cacheReadInputTokens += usage.cacheReadInputTokens;
    acc.cacheCreationInputTokens += usage.cacheCreationInputTokens;
    acc.webSearchRequests += usage.webSearchRequests;
    acc.costUSD += usage.costUSD;
  }
  const aggregated = Object.entries(usageByShortName);
  if (aggregated.length > 0) lines.push('Usage by model:');
  for (const [shortName, usage] of aggregated) {
    let line = `${formatNumber(usage.inputTokens)} input, ${formatNumber(usage.outputTokens)} output`;
    if (usage.cacheReadInputTokens > 0) line += `, ${formatNumber(usage.cacheReadInputTokens)} cache read`;
    if (usage.cacheCreationInputTokens > 0) line += `, ${formatNumber(usage.cacheCreationInputTokens)} cache write`;
    if (usage.webSearchRequests > 0) line += `, ${formatNumber(usage.webSearchRequests)} web search`;
    line += ` (${formatCost(usage.costUSD)})`;
    lines.push(`${`${shortName}:`.padStart(21)} ${line}`);
  }
  lines.push(dim('Aggregated across all sessions in this project — includes the current session live.'));

  // ── Rate-limit bars ──
  lines.push('');
  if (utilLoading && !util) {
    lines.push(dim('Loading usage data…'));
  } else if (utilError) {
    lines.push(colorize(`Could not load rate-limit data: ${utilError}`, theme.error, 'foreground'));
    lines.push(dim('(cost/usage totals above are unaffected) · r to retry'));
  } else if (util) {
    const subscriptionType = getSubscriptionType();
    const showSonnet = subscriptionType === 'max' || subscriptionType === 'team' || subscriptionType === null;
    const bars: Array<[string, RateLimit | null | undefined]> = [
      ['Current session', util.five_hour],
      ['Current week (all models)', util.seven_day],
      ...(showSonnet ? [['Current week (Sonnet only)', util.seven_day_sonnet] as [string, RateLimit | null | undefined]] : []),
    ];
    if (!bars.some(([, l]) => l)) {
      lines.push(dim('/usage is only available for subscription plans.'));
    }
    let firstBar = true;
    for (const [title, limit] of bars) {
      if (!limit || limit.utilization === null) continue;
      if (!firstBar) lines.push('');
      firstBar = false;
      lines.push(bold(title));
      lines.push(`${makeBar(limit.utilization / 100)} ${Math.floor(limit.utilization)}% used`);
      if (limit.resets_at) lines.push(dim(`Resets ${formatResetText(limit.resets_at, true, true)}`));
    }
    const eu = util.extra_usage;
    if (eu?.is_enabled && typeof eu.used_credits === 'number' && typeof eu.utilization === 'number' && eu.monthly_limit != null) {
      lines.push('');
      lines.push(bold('Extra usage'));
      lines.push(`${makeBar(eu.utilization / 100)} ${Math.floor(eu.utilization)}% used`);
      lines.push(dim(`${formatCost(eu.used_credits / 100, 2)} / ${formatCost(eu.monthly_limit / 100, 2)} spent`));
    }
  }

  // ── "What's driving your token usage?" ──
  lines.push('');
  const windowLabel = contribWindow === 'day' ? 'last 24h' : 'last week';
  lines.push(bold("What's driving your token usage?"));
  lines.push(dim('Approximate, based on local sessions on this machine — does not include other devices.'));
  lines.push(dim(`${windowLabel[0]!.toUpperCase()}${windowLabel.slice(1)} · a characteristic of your usage, not a full breakdown`));
  if (contribLoading && !contrib) {
    lines.push(dim('Analyzing local sessions…'));
  } else if (!contrib || contrib.totalTokens === 0) {
    lines.push(dim(`No local session activity in the ${windowLabel}.`));
  } else {
    if (contrib.subagentHeavyPct >= 5) {
      lines.push('');
      lines.push(`${Math.round(contrib.subagentHeavyPct)}% of your token usage came from subagent-heavy sessions.`);
      lines.push(dim(CONTRIBUTION_ADVICE));
    }
    const topAgent = contrib.agentBreakdown[0];
    if (topAgent) {
      lines.push('');
      lines.push(`${Math.round(topAgent.pct)}% of your token usage came from subagents under '${topAgent.agentType}'.`);
    }
    if (contrib.agentBreakdown.length > 0) {
      lines.push('');
      lines.push('Subagents'.padEnd(24) + '% of usage');
      for (const a of contrib.agentBreakdown) {
        lines.push(a.agentType.padEnd(24) + `${Math.round(a.pct)}%`);
      }
    }
  }

  const maxOffset = Math.max(0, lines.length - bodyRows);
  // Adjust-state-during-render (React-blessed pattern): clamp a runaway offset
  // from repeated ↓ so it doesn't grow unbounded. Guarded, so it bails fast.
  if (offset > maxOffset) setOffset(maxOffset);
  const clampedOffset = Math.min(offset, maxOffset);
  const visible = lines.slice(clampedOffset, clampedOffset + bodyRows);
  const above = clampedOffset;
  const below = lines.length - (clampedOffset + visible.length);

  return (
    <Box flexDirection="column" width="100%">
      <Text dimColor>{above > 0 ? `↑ ${above} more above` : ' '}</Text>
      <RawAnsi lines={visible} width={width} />
      <Text dimColor>{below > 0 ? `↓ ${below} more below` : ' '}</Text>
      <Text dimColor>↑↓ scroll · d to day · w to week · Esc to close</Text>
    </Box>
  );
}
