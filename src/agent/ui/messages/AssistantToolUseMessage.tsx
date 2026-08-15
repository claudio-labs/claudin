import { c as _c } from "react-compiler-runtime";
import type { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React, { useMemo } from 'react';
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js';
import type { ThemeName } from 'src/terminal/theme/theme.js';
import type { Command } from 'src/commands/commands.js';
import { BLACK_CIRCLE } from 'src/constants/figures.js';
import { stringWidth } from 'src/terminal/ink/stringWidth.js';
import { Box, Text, useTheme } from 'src/terminal/ink.js';
import { type AppState, useAppStateMaybeOutsideOfProvider } from 'src/terminal/state/AppState.js';
import { findToolByName, type Tool, type ToolProgressData, type Tools } from 'src/tools/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';
import { useIsClassifierChecking } from 'src/permissions/classifierApprovalsHook.js';
import { logError } from 'src/shared/log.js';
import type { buildMessageLookups } from 'src/agent/messages/messages.js';
import { MessageResponse } from 'src/agent/ui/MessageResponse.js';
import { useSelectedMessageBg } from 'src/agent/ui/messageActions.js';
import { SentryErrorBoundary } from 'src/platform/SentryErrorBoundary.js';
import { ToolUseLoader } from 'src/agent/ui/ToolUseLoader.js';
import { HookProgressMessage } from 'src/agent/ui/messages/HookProgressMessage.js';
type Props = {
  param: ToolUseBlockParam;
  addMargin: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  progressMessagesForMessage: ProgressMessage[];
  shouldAnimate: boolean;
  shouldShowDot: boolean;
  inProgressToolCallCount?: number;
  lookups: ReturnType<typeof buildMessageLookups>;
  isTranscriptMode?: boolean;
};
export function AssistantToolUseMessage(t0: Props) {
  const $ = _c(82);
  const {
    param,
    addMargin,
    tools,
    commands,
    verbose,
    inProgressToolUseIDs,
    progressMessagesForMessage,
    shouldAnimate,
    shouldShowDot,
    inProgressToolCallCount,
    lookups,
    isTranscriptMode
  } = t0;
  const terminalSize = useTerminalSize();
  const [theme] = useTheme();
  const bg = useSelectedMessageBg();
  const pendingWorkerRequest = useAppStateMaybeOutsideOfProvider(_temp);
  const isClassifierCheckingRaw = useIsClassifierChecking(param.id);
  const permissionMode = useAppStateMaybeOutsideOfProvider(_temp2);
  const hasStrippedRules = useAppStateMaybeOutsideOfProvider(_temp3);
  const isAutoClassifier = permissionMode === "auto" || permissionMode === "plan" && hasStrippedRules;
  const isClassifierChecking = false && isClassifierCheckingRaw && permissionMode !== "auto";
  let t1;
  if ($[0] !== param.input || $[1] !== param.name || $[2] !== tools) {
    bb0: {
      if (!tools) {
        t1 = null;
        break bb0;
      }
      const tool = findToolByName(tools, param.name);
      if (!tool) {
        t1 = null;
        break bb0;
      }
      const input = tool.inputSchema.safeParse(param.input);
      const data = input.success ? input.data : undefined;
      t1 = {
        tool,
        input,
        userFacingToolName: tool.userFacingName(data),
        userFacingToolNameBackgroundColor: tool.userFacingNameBackgroundColor?.(data),
        isTransparentWrapper: tool.isTransparentWrapper?.() ?? false
      };
    }
    $[0] = param.input;
    $[1] = param.name;
    $[2] = tools;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  const parsed = t1;
  if (!parsed) {
    logError(new Error(tools ? `Tool ${param.name} not found` : `Tools array is undefined for tool ${param.name}`));
    return null;
  }
  const {
    tool: tool_0,
    input: input_0,
    userFacingToolName,
    userFacingToolNameBackgroundColor,
    isTransparentWrapper
  } = parsed;
  let t2;
  if ($[4] !== lookups.resolvedToolUseIDs || $[5] !== param.id) {
    t2 = lookups.resolvedToolUseIDs.has(param.id);
    $[4] = lookups.resolvedToolUseIDs;
    $[5] = param.id;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  const isResolved = t2;
  let t3;
  if ($[7] !== inProgressToolUseIDs || $[8] !== isResolved || $[9] !== param.id) {
    t3 = !inProgressToolUseIDs.has(param.id) && !isResolved;
    $[7] = inProgressToolUseIDs;
    $[8] = isResolved;
    $[9] = param.id;
    $[10] = t3;
  } else {
    t3 = $[10];
  }
  const isQueued = t3;
  const isWaitingForPermission = pendingWorkerRequest?.toolUseId === param.id;
  if (isTransparentWrapper) {
    if (isQueued || isResolved) {
      return null;
    }
    let t4;
    if ($[11] !== inProgressToolCallCount || $[12] !== isTranscriptMode || $[13] !== lookups || $[14] !== param.id || $[15] !== progressMessagesForMessage || $[16] !== terminalSize || $[17] !== tool_0 || $[18] !== tools || $[19] !== verbose) {
      t4 = renderToolUseProgressMessage(tool_0, tools, lookups, param.id, progressMessagesForMessage, {
        verbose,
        inProgressToolCallCount,
        isTranscriptMode
      }, terminalSize);
      $[11] = inProgressToolCallCount;
      $[12] = isTranscriptMode;
      $[13] = lookups;
      $[14] = param.id;
      $[15] = progressMessagesForMessage;
      $[16] = terminalSize;
      $[17] = tool_0;
      $[18] = tools;
      $[19] = verbose;
      $[20] = t4;
    } else {
      t4 = $[20];
    }
    let t5;
    if ($[21] !== bg || $[22] !== t4) {
      t5 = <Box flexDirection="column" width="100%" backgroundColor={bg}>{t4}</Box>;
      $[21] = bg;
      $[22] = t4;
      $[23] = t5;
    } else {
      t5 = $[23];
    }
    return t5;
  }
  if (userFacingToolName === "") {
    return null;
  }
  let t4;
  if ($[24] !== commands || $[25] !== input_0.data || $[26] !== input_0.success || $[27] !== theme || $[28] !== tool_0 || $[29] !== verbose) {
    t4 = input_0.success ? renderToolUseMessage(tool_0, input_0.data, {
      theme,
      verbose,
      commands
    }) : null;
    $[24] = commands;
    $[25] = input_0.data;
    $[26] = input_0.success;
    $[27] = theme;
    $[28] = tool_0;
    $[29] = verbose;
    $[30] = t4;
  } else {
    t4 = $[30];
  }
  const renderedToolUseMessage = t4;
  if (renderedToolUseMessage === null) {
    return null;
  }
  const t5 = addMargin ? 1 : 0;
  const t6 = stringWidth(userFacingToolName) + (shouldShowDot ? 2 : 0);
  // Async-launched agents have a tool_result (so isResolved=true) but should keep
  // showing a live indicator: green, blinking. Treat them as resolved-but-active.
  // Gate on inProgressToolUseIDs (which Messages.tsx merges with the live
  // running-async set) so the blink stops once the agent's task completes.
  const isAsync = lookups.asyncLaunchedToolUseIDs.has(param.id) && inProgressToolUseIDs.has(param.id);
  const isUnresolved = !isResolved && !isAsync;
  const effectiveShouldAnimate = shouldAnimate || isAsync;
  let t7;
  if ($[31] !== isAsync || $[32] !== isQueued || $[33] !== isUnresolved || $[34] !== lookups.erroredToolUseIDs || $[35] !== param.id || $[36] !== effectiveShouldAnimate || $[37] !== shouldShowDot) {
    t7 = shouldShowDot && (isQueued ? <Box minWidth={2}><Text dimColor={isQueued}>{BLACK_CIRCLE}</Text></Box> : <ToolUseLoader shouldAnimate={effectiveShouldAnimate} isUnresolved={isUnresolved} isError={lookups.erroredToolUseIDs.has(param.id)} isAsync={isAsync} />);
    $[31] = isAsync;
    $[32] = isQueued;
    $[33] = isUnresolved;
    $[34] = lookups.erroredToolUseIDs;
    $[35] = param.id;
    $[36] = effectiveShouldAnimate;
    $[37] = shouldShowDot;
    $[38] = t7;
  } else {
    t7 = $[38];
  }
  const t8 = userFacingToolNameBackgroundColor ? "inverseText" : undefined;
  let t9;
  if ($[39] !== t8 || $[40] !== userFacingToolName || $[41] !== userFacingToolNameBackgroundColor) {
    t9 = <Box flexShrink={0}><Text bold={true} wrap="truncate-end" backgroundColor={userFacingToolNameBackgroundColor} color={t8}>{userFacingToolName}</Text></Box>;
    $[39] = t8;
    $[40] = userFacingToolName;
    $[41] = userFacingToolNameBackgroundColor;
    $[42] = t9;
  } else {
    t9 = $[42];
  }
  let t10;
  if ($[43] !== renderedToolUseMessage) {
    t10 = renderedToolUseMessage !== "" && <Box flexWrap="nowrap"><Text>({renderedToolUseMessage})</Text></Box>;
    $[43] = renderedToolUseMessage;
    $[44] = t10;
  } else {
    t10 = $[44];
  }
  let t11;
  if ($[45] !== input_0.data || $[46] !== input_0.success || $[47] !== tool_0) {
    t11 = input_0.success && tool_0.renderToolUseTag && tool_0.renderToolUseTag(input_0.data);
    $[45] = input_0.data;
    $[46] = input_0.success;
    $[47] = tool_0;
    $[48] = t11;
  } else {
    t11 = $[48];
  }
  let t12;
  if ($[49] !== t10 || $[50] !== t11 || $[51] !== t6 || $[52] !== t7 || $[53] !== t9) {
    t12 = <Box flexDirection="row" flexWrap="nowrap" minWidth={t6}>{t7}{t9}{t10}{t11}</Box>;
    $[49] = t10;
    $[50] = t11;
    $[51] = t6;
    $[52] = t7;
    $[53] = t9;
    $[54] = t12;
  } else {
    t12 = $[54];
  }
  let t13;
  if ($[55] !== inProgressToolCallCount || $[56] !== isAutoClassifier || $[57] !== isClassifierChecking || $[58] !== isQueued || $[59] !== isResolved || $[60] !== isTranscriptMode || $[61] !== isWaitingForPermission || $[62] !== lookups || $[63] !== param.id || $[64] !== progressMessagesForMessage || $[65] !== terminalSize || $[66] !== tool_0 || $[67] !== tools || $[68] !== verbose) {
    t13 = !isResolved && !isQueued && (isClassifierChecking ? <MessageResponse height={1}><Text dimColor={true}>{isAutoClassifier ? "Auto classifier checking\u2026" : "Bash classifier checking\u2026"}</Text></MessageResponse> : isWaitingForPermission ? <MessageResponse height={1}><Text dimColor={true}>Waiting for permission…</Text></MessageResponse> : renderToolUseProgressMessage(tool_0, tools, lookups, param.id, progressMessagesForMessage, {
      verbose,
      inProgressToolCallCount,
      isTranscriptMode
    }, terminalSize));
    $[55] = inProgressToolCallCount;
    $[56] = isAutoClassifier;
    $[57] = isClassifierChecking;
    $[58] = isQueued;
    $[59] = isResolved;
    $[60] = isTranscriptMode;
    $[61] = isWaitingForPermission;
    $[62] = lookups;
    $[63] = param.id;
    $[64] = progressMessagesForMessage;
    $[65] = terminalSize;
    $[66] = tool_0;
    $[67] = tools;
    $[68] = verbose;
    $[69] = t13;
  } else {
    t13 = $[69];
  }
  let t14;
  if ($[70] !== isQueued || $[71] !== isResolved || $[72] !== tool_0) {
    t14 = !isResolved && isQueued && renderToolUseQueuedMessage(tool_0);
    $[70] = isQueued;
    $[71] = isResolved;
    $[72] = tool_0;
    $[73] = t14;
  } else {
    t14 = $[73];
  }
  let t15;
  if ($[74] !== t12 || $[75] !== t13 || $[76] !== t14) {
    t15 = <Box flexDirection="column">{t12}{t13}{t14}</Box>;
    $[74] = t12;
    $[75] = t13;
    $[76] = t14;
    $[77] = t15;
  } else {
    t15 = $[77];
  }
  let t16;
  if ($[78] !== bg || $[79] !== t15 || $[80] !== t5) {
    t16 = <Box flexDirection="row" justifyContent="space-between" marginTop={t5} width="100%" backgroundColor={bg}>{t15}</Box>;
    $[78] = bg;
    $[79] = t15;
    $[80] = t5;
    $[81] = t16;
  } else {
    t16 = $[81];
  }
  return t16;
}
function _temp3(state_1: AppState) {
  return !!state_1.toolPermissionContext.strippedDangerousRules;
}
function _temp2(state_0: AppState) {
  return state_0.toolPermissionContext.mode;
}
function _temp(state: AppState) {
  return state.pendingWorkerRequest;
}
function renderToolUseMessage(tool: Tool, input: unknown, {
  theme,
  verbose,
  commands
}: {
  theme: ThemeName;
  verbose: boolean;
  commands: Command[];
}): React.ReactNode {
  try {
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return '';
    }
    return tool.renderToolUseMessage(parsed.data, {
      theme,
      verbose,
      commands
    });
  } catch (error) {
    logError(new Error(`Error rendering tool use message for ${tool.name}: ${error}`));
    return '';
  }
}
function renderToolUseProgressMessage(tool: Tool, tools: Tools, lookups: ReturnType<typeof buildMessageLookups>, toolUseID: string, progressMessagesForMessage: ProgressMessage[], {
  verbose,
  inProgressToolCallCount,
  isTranscriptMode
}: {
  verbose: boolean;
  inProgressToolCallCount?: number;
  isTranscriptMode?: boolean;
}, terminalSize: {
  columns: number;
  rows: number;
}): React.ReactNode {
  const toolProgressMessages = progressMessagesForMessage.filter((msg): msg is ProgressMessage<ToolProgressData> => msg.data.type !== 'hook_progress');
  try {
    const toolMessages = tool.renderToolUseProgressMessage?.(toolProgressMessages, {
      tools,
      verbose,
      terminalSize,
      inProgressToolCallCount: inProgressToolCallCount ?? 1,
      isTranscriptMode
    }) ?? null;
    return <>
        <SentryErrorBoundary>
          <HookProgressMessage hookEvent="PreToolUse" lookups={lookups} toolUseID={toolUseID} verbose={verbose} isTranscriptMode={isTranscriptMode} />
        </SentryErrorBoundary>
        {toolMessages}
      </>;
  } catch (error) {
    logError(new Error(`Error rendering tool use progress message for ${tool.name}: ${error}`));
    return null;
  }
}
function renderToolUseQueuedMessage(tool: Tool): React.ReactNode {
  try {
    return tool.renderToolUseQueuedMessage?.();
  } catch (error) {
    logError(new Error(`Error rendering tool use queued message for ${tool.name}: ${error}`));
    return null;
  }
}
