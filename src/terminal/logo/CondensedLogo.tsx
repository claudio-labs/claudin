import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { type ReactNode, useEffect } from 'react';
import { useMainLoopModel } from 'src/agent/hooks/useMainLoopModel.js';
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js';
import { stringWidth } from 'src/terminal/ink/stringWidth.js';
import { Box, Text } from 'src/terminal/ink.js';
import { useAppState } from 'src/terminal/state/AppState.js';
import type { AppState } from 'src/terminal/state/AppStateStore.js';
import { getEffortSuffix } from 'src/providers/effort/effort.js';
import { truncate } from 'src/shared/text/format.js';
import { isFullscreenEnvEnabled } from 'src/terminal/render/fullscreen.js';
import { formatModelAndBilling, getLogoDisplayData, truncatePath } from 'src/terminal/logoV2Utils.js';
import { renderModelSetting } from 'src/providers/model/model.js';
import { OffscreenFreeze } from 'src/terminal/render/OffscreenFreeze.js';
import { AnimatedClawd } from 'src/terminal/logo/AnimatedClawd.js';
import { Clawd } from 'src/terminal/logo/Clawd.js';
export function CondensedLogo() {
  const $ = _c(29);
  const {
    columns
  } = useTerminalSize();
  const agent = useAppState(_temp);
  const effortValue = useAppState(_temp2);
  const model = useMainLoopModel();
  const modelDisplayName = renderModelSetting(model);
  const {
    version,
    cwd,
    billingType,
    agentName: agentNameFromSettings
  } = getLogoDisplayData();
  const agentName = agent ?? agentNameFromSettings;
  // The two upsell "seen count" effects lived here — guest passes and overage
  // credit. Slots $[0]-$[6] stay allocated: React Compiler output, so the
  // numbering below is bookkeeping and must not shift.
  const textWidth = Math.max(columns - 15, 20);
  const truncatedVersion = truncate(version, Math.max(textWidth - 13, 6));
  const effortSuffix = getEffortSuffix(model, effortValue);
  const {
    shouldSplit,
    truncatedModel,
    truncatedBilling
  } = formatModelAndBilling(modelDisplayName + effortSuffix, billingType, textWidth);
  const cwdAvailableWidth = agentName ? textWidth - 1 - stringWidth(agentName) - 3 : textWidth;
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10));
  let t4;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = isFullscreenEnvEnabled() ? <AnimatedClawd /> : <Clawd />;
    $[7] = t4;
  } else {
    t4 = $[7];
  }
  let t5;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Text bold={true}>OPEN CLAUDE</Text>;
    $[8] = t5;
  } else {
    t5 = $[8];
  }
  let t6;
  if ($[9] !== truncatedVersion) {
    t6 = <Text>{t5} <Text dimColor={true}>v{truncatedVersion}</Text></Text>;
    $[9] = truncatedVersion;
    $[10] = t6;
  } else {
    t6 = $[10];
  }
  const t6a = 'Open terminal for any LLM';
  let t7;
  if ($[11] !== shouldSplit || $[12] !== truncatedBilling || $[13] !== truncatedModel) {
    t7 = shouldSplit ? <><Text><Text color="inactive">Model</Text><Text dimColor={true}>  {truncatedModel}</Text></Text><Text><Text color="inactive">Mode</Text><Text dimColor={true}>   {truncatedBilling}</Text></Text></> : <Text><Text color="inactive">Model</Text><Text dimColor={true}>  {truncatedModel} · {truncatedBilling}</Text></Text>;
    $[11] = shouldSplit;
    $[12] = truncatedBilling;
    $[13] = truncatedModel;
    $[14] = t7;
  } else {
    t7 = $[14];
  }
  const t8 = agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd;
  let t9;
  if ($[15] !== t8) {
    t9 = <Text><Text color="inactive">Path</Text><Text dimColor={true}>   {t8}</Text></Text>;
    $[15] = t8;
    $[16] = t9;
  } else {
    t9 = $[16];
  }
  let t12;
  if ($[25] !== t6 || $[26] !== t7 || $[27] !== t9) {
    t12 = <OffscreenFreeze><Box borderStyle="round" borderColor="inactive" paddingX={2} paddingY={0} flexDirection="row" gap={2} alignItems="center"><Box flexDirection="column" alignItems="center"><Text color="inactive">•</Text>{t4}<Text color="inactive">•</Text></Box><Box flexDirection="column"><Text bold={true}>OPEN CLAUDE</Text><Text dimColor={true}>{t6a}</Text><Box marginTop={1}>{t6}</Box>{t7}{t9}</Box></Box></OffscreenFreeze>;
    $[25] = t6;
    $[26] = t7;
    $[27] = t9;
    $[28] = t12;
  } else {
    t12 = $[28];
  }
  return t12;
}
function _temp2(s_0: AppState) {
  return s_0.effortValue;
}
function _temp(s: AppState) {
  return s.agent;
}
