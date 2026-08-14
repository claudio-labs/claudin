import { c as _c } from "react-compiler-runtime";
import { feature } from 'bun:bundle';
import * as React from 'react';
import { Box, Text } from 'src/ink.js';
import type { ContextData } from 'src/utils/analyzeContext.js';
import { generateContextSuggestions } from 'src/utils/contextSuggestions.js';
import { getDisplayPath } from 'src/utils/file.js';
import { formatTokens } from 'src/utils/format.js';
import { getSourceDisplayName, type SettingSource } from 'src/utils/settings/constants.js';
import { plural } from 'src/utils/stringUtils.js';
import { ContextSuggestions } from './ContextSuggestions.js';

// The element types behind ContextData's collections are not exported from
// analyzeContext.ts, so they are recovered here by indexed access. They exist
// to annotate the callbacks the React Compiler hoisted to module scope below,
// which lost their contextual typing in the process.
type ContextCategory = ContextData['categories'][number];
type GridSquare = ContextData['gridRows'][number][number];
type MemoryFileInfo = ContextData['memoryFiles'][number];
type McpToolInfo = ContextData['mcpTools'][number];
type AgentInfo = ContextData['agents'][number];
type SkillFrontmatterInfo =
  NonNullable<ContextData['skills']>['skillFrontmatter'][number];
type SystemToolInfo = NonNullable<ContextData['systemTools']>[number];
type DeferredBuiltinToolInfo = NonNullable<
  ContextData['deferredBuiltinTools']
>[number];
type SystemPromptSectionInfo = NonNullable<
  ContextData['systemPromptSections']
>[number];
type ToolCallByType = NonNullable<
  ContextData['messageBreakdown']
>['toolCallsByType'][number];
type AttachmentByType = NonNullable<
  ContextData['messageBreakdown']
>['attachmentsByType'][number];
const RESERVED_CATEGORY_NAME = 'Autocompact buffer';

/**
 * The `[internal]` panels below (system tools, system prompt sections, message
 * breakdown) are Ant-only and stay hidden in this fork. Declaring the switch as
 * `boolean` instead of leaving the literal `false` in the `&&` chain keeps
 * TypeScript's narrowing alive inside those branches: after a literal `false`
 * the rest of the chain is unreachable, and unreachable code falls back to
 * declared types, discarding the `x && …` guards the compiler emitted.
 */
const SHOW_INTERNAL_PANELS: boolean = false;

/**
 * Tree connector for a list item: '├' for every item except the last, which
 * gets '└'. Relies on Array.prototype.map passing (item, index, array) to the
 * render callbacks, so a connected spine is drawn without threading the list
 * length through each renderer.
 */
function branchPrefix(index: number, arr: readonly unknown[]): string {
  return index === arr.length - 1 ? '└' : '├';
}

/**
 * One-liner for the legend header showing what context-collapse has done.
 * Returns null when nothing's summarized/staged so we don't add visual
 * noise in the common case. This is the one place a user can see that
 * their context was rewritten — the <collapsed> placeholders are isMeta
 * and don't appear in the conversation view.
 */
function CollapseStatus() {
  const $ = _c(2);
  if (feature("CONTEXT_COLLAPSE")) {
    let t0;
    let t1;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      t1 = Symbol.for("react.early_return_sentinel");
      bb0: {
        const {
          getStats,
          isContextCollapseEnabled
        } = require("src/services/contextCollapse/index.js") as typeof import('src/services/contextCollapse/index.js');
        if (!isContextCollapseEnabled()) {
          t1 = null;
          break bb0;
        }
        const s = getStats();
        const {
          health: h
        } = s;
        const parts = [];
        if (s.collapsedSpans > 0) {
          parts.push(`${s.collapsedSpans} ${plural(s.collapsedSpans, "span")} summarized (${s.collapsedMessages} msgs)`);
        }
        if (s.stagedSpans > 0) {
          parts.push(`${s.stagedSpans} staged`);
        }
        const summary = parts.length > 0 ? parts.join(", ") : h.totalSpawns > 0 ? `${h.totalSpawns} ${plural(h.totalSpawns, "spawn")}, nothing staged yet` : "waiting for first trigger";
        let line2 = null;
        if (h.totalErrors > 0) {
          line2 = <Text color="warning">Collapse errors: {h.totalErrors}/{h.totalSpawns} spawns failed{h.lastError ? ` (last: ${h.lastError.slice(0, 60)})` : ""}</Text>;
        } else {
          if (h.emptySpawnWarningEmitted) {
            line2 = <Text color="warning">Collapse idle: {h.totalEmptySpawns} consecutive empty runs</Text>;
          }
        }
        t0 = <><Text dimColor={true}>Context strategy: collapse ({summary})</Text>{line2}</>;
      }
      $[0] = t0;
      $[1] = t1;
    } else {
      t0 = $[0];
      t1 = $[1];
    }
    if (t1 !== Symbol.for("react.early_return_sentinel")) {
      return t1;
    }
    return t0;
  }
  return null;
}

// Order for displaying source groups: Project > User > Managed > Plugin > Built-in
const SOURCE_DISPLAY_ORDER = ['Project', 'User', 'Managed', 'Plugin', 'Built-in'];

/** Group items by source type for display, sorted by tokens descending within each group */
function groupBySource<T extends {
  source: SettingSource | 'plugin' | 'built-in' | 'bundled';
  tokens: number;
}>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = getSourceDisplayName(item.source);
    const existing = groups.get(key) || [];
    existing.push(item);
    groups.set(key, existing);
  }
  // Sort each group by tokens descending
  for (const [key, group] of groups.entries()) {
    groups.set(key, group.sort((a, b) => b.tokens - a.tokens));
  }
  // Return groups in consistent order
  const orderedGroups = new Map<string, T[]>();
  for (const source of SOURCE_DISPLAY_ORDER) {
    const group = groups.get(source);
    if (group) {
      orderedGroups.set(source, group);
    }
  }
  return orderedGroups;
}
interface Props {
  data: ContextData;
}
export function ContextVisualization(t0: Props) {
  const $ = _c(87);
  const {
    data
  } = t0;
  const {
    categories,
    totalTokens,
    rawMaxTokens,
    percentage,
    gridRows,
    model,
    memoryFiles,
    mcpTools,
    deferredBuiltinTools: t1,
    systemTools,
    systemPromptSections,
    agents,
    skills,
    messageBreakdown
  } = data;
  let T0;
  let T1;
  let t2;
  let t3;
  let t4;
  let t5;
  let t6;
  let t7;
  let t8;
  let t9;
  if ($[0] !== categories || $[1] !== gridRows || $[2] !== mcpTools || $[3] !== model || $[4] !== percentage || $[5] !== rawMaxTokens || $[6] !== systemTools || $[7] !== t1 || $[8] !== totalTokens) {
    const deferredBuiltinTools = t1 === undefined ? [] : t1;
    const visibleCategories = categories.filter(_temp);
    let t10;
    if ($[19] !== categories) {
      t10 = categories.some(_temp2);
      $[19] = categories;
      $[20] = t10;
    } else {
      t10 = $[20];
    }
    const hasDeferredMcpTools = t10;
    const hasDeferredBuiltinTools = deferredBuiltinTools.length > 0;
    const autocompactCategory = categories.find(_temp3);
    T1 = Box;
    t6 = "column";
    t7 = 1;
    if ($[21] === Symbol.for("react.memo_cache_sentinel")) {
      t8 = <Text bold={true}>Context Usage</Text>;
      $[21] = t8;
    } else {
      t8 = $[21];
    }
    let t11;
    if ($[22] !== gridRows) {
      t11 = gridRows.map(_temp5);
      $[22] = gridRows;
      $[23] = t11;
    } else {
      t11 = $[23];
    }
    let t12;
    if ($[24] !== t11) {
      t12 = <Box flexDirection="column" flexShrink={0} marginLeft={-1}>{t11}</Box>;
      $[24] = t11;
      $[25] = t12;
    } else {
      t12 = $[25];
    }
    let t13;
    if ($[26] !== totalTokens) {
      t13 = formatTokens(totalTokens);
      $[26] = totalTokens;
      $[27] = t13;
    } else {
      t13 = $[27];
    }
    let t14;
    if ($[28] !== rawMaxTokens) {
      t14 = formatTokens(rawMaxTokens);
      $[28] = rawMaxTokens;
      $[29] = t14;
    } else {
      t14 = $[29];
    }
    let t15;
    if ($[30] !== model || $[31] !== percentage || $[32] !== t13 || $[33] !== t14) {
      t15 = <Text dimColor={true}>{model} · {t13}/{t14}{" "}tokens ({percentage}%)</Text>;
      $[30] = model;
      $[31] = percentage;
      $[32] = t13;
      $[33] = t14;
      $[34] = t15;
    } else {
      t15 = $[34];
    }
    let t16;
    let t17;
    let t18;
    if ($[35] === Symbol.for("react.memo_cache_sentinel")) {
      t16 = <CollapseStatus />;
      t17 = <Text> </Text>;
      t18 = <Text dimColor={true} italic={true}>Estimated usage by category</Text>;
      $[35] = t16;
      $[36] = t17;
      $[37] = t18;
    } else {
      t16 = $[35];
      t17 = $[36];
      t18 = $[37];
    }
    let t19;
    if ($[38] !== rawMaxTokens) {
      t19 = (cat_2: ContextCategory, index: number) => {
        const tokenDisplay = formatTokens(cat_2.tokens);
        const percentDisplay = cat_2.isDeferred ? "N/A" : `${(cat_2.tokens / rawMaxTokens * 100).toFixed(1)}%`;
        const isReserved = cat_2.name === RESERVED_CATEGORY_NAME;
        const displayName = cat_2.name;
        const symbol = cat_2.isDeferred ? " " : isReserved ? "\u26DD" : "\u26C1";
        return <Box key={index}><Text color={cat_2.color}>{symbol}</Text><Text> {displayName}: </Text><Text dimColor={true}>{tokenDisplay} tokens ({percentDisplay})</Text></Box>;
      };
      $[38] = rawMaxTokens;
      $[39] = t19;
    } else {
      t19 = $[39];
    }
    const t20 = visibleCategories.map(t19);
    let t21;
    if ($[40] !== categories || $[41] !== rawMaxTokens) {
      t21 = (categories.find(_temp6)?.tokens ?? 0) > 0 && <Box><Text dimColor={true}>⛶</Text><Text> Free space: </Text><Text dimColor={true}>{formatTokens(categories.find(_temp7)?.tokens || 0)}{" "}({((categories.find(_temp8)?.tokens || 0) / rawMaxTokens * 100).toFixed(1)}%)</Text></Box>;
      $[40] = categories;
      $[41] = rawMaxTokens;
      $[42] = t21;
    } else {
      t21 = $[42];
    }
    const t22 = autocompactCategory && autocompactCategory.tokens > 0 && <Box><Text color={autocompactCategory.color}>⛝</Text><Text dimColor={true}> {autocompactCategory.name}: </Text><Text dimColor={true}>{formatTokens(autocompactCategory.tokens)} tokens ({(autocompactCategory.tokens / rawMaxTokens * 100).toFixed(1)}%)</Text></Box>;
    let t23;
    if ($[43] !== t15 || $[44] !== t20 || $[45] !== t21 || $[46] !== t22) {
      t23 = <Box flexDirection="column" gap={0} flexShrink={0}>{t15}{t16}{t17}{t18}{t20}{t21}{t22}</Box>;
      $[43] = t15;
      $[44] = t20;
      $[45] = t21;
      $[46] = t22;
      $[47] = t23;
    } else {
      t23 = $[47];
    }
    if ($[48] !== t12 || $[49] !== t23) {
      t9 = <Box flexDirection="row" gap={2}>{t12}{t23}</Box>;
      $[48] = t12;
      $[49] = t23;
      $[50] = t9;
    } else {
      t9 = $[50];
    }
    T0 = Box;
    t2 = "column";
    t3 = -1;
    if ($[51] !== hasDeferredMcpTools || $[52] !== mcpTools) {
      t4 = mcpTools.length > 0 && <Box flexDirection="column" marginTop={1}><Box><Text bold={true}>MCP tools</Text><Text dimColor={true}>{" "}· /mcp{hasDeferredMcpTools ? " (loaded on-demand)" : ""}</Text></Box>{mcpTools.some(_temp9) && <Box flexDirection="column" marginTop={1}><Text dimColor={true}>Loaded</Text>{mcpTools.filter(_temp0).map(_temp1)}</Box>}{hasDeferredMcpTools && mcpTools.some(_temp10) && <Box flexDirection="column" marginTop={1}><Text dimColor={true}>Available</Text>{mcpTools.filter(_temp11).map(_temp12)}</Box>}{!hasDeferredMcpTools && mcpTools.map(_temp13)}</Box>;
      $[51] = hasDeferredMcpTools;
      $[52] = mcpTools;
      $[53] = t4;
    } else {
      t4 = $[53];
    }
    t5 = (systemTools && systemTools.length > 0 || hasDeferredBuiltinTools) && SHOW_INTERNAL_PANELS && <Box flexDirection="column" marginTop={1}><Box><Text bold={true}>[internal] System tools</Text>{hasDeferredBuiltinTools && <Text dimColor={true}> (some loaded on-demand)</Text>}</Box><Box flexDirection="column" marginTop={1}><Text dimColor={true}>Loaded</Text>{systemTools?.map(_temp14)}{deferredBuiltinTools.filter(_temp15).map(_temp16)}</Box>{hasDeferredBuiltinTools && deferredBuiltinTools.some(_temp17) && <Box flexDirection="column" marginTop={1}><Text dimColor={true}>Available</Text>{deferredBuiltinTools.filter(_temp18).map(_temp19)}</Box>}</Box>;
    $[0] = categories;
    $[1] = gridRows;
    $[2] = mcpTools;
    $[3] = model;
    $[4] = percentage;
    $[5] = rawMaxTokens;
    $[6] = systemTools;
    $[7] = t1;
    $[8] = totalTokens;
    $[9] = T0;
    $[10] = T1;
    $[11] = t2;
    $[12] = t3;
    $[13] = t4;
    $[14] = t5;
    $[15] = t6;
    $[16] = t7;
    $[17] = t8;
    $[18] = t9;
  } else {
    T0 = $[9];
    T1 = $[10];
    t2 = $[11];
    t3 = $[12];
    t4 = $[13];
    t5 = $[14];
    t6 = $[15];
    t7 = $[16];
    t8 = $[17];
    t9 = $[18];
  }
  let t10;
  if ($[54] !== systemPromptSections) {
    t10 = systemPromptSections && systemPromptSections.length > 0 && SHOW_INTERNAL_PANELS && <Box flexDirection="column" marginTop={1}><Text bold={true}>[internal] System prompt sections</Text>{systemPromptSections.map(_temp20)}</Box>;
    $[54] = systemPromptSections;
    $[55] = t10;
  } else {
    t10 = $[55];
  }
  let t11;
  if ($[56] !== agents) {
    t11 = agents.length > 0 && <Box flexDirection="column" marginTop={1}><Box><Text bold={true}>Custom agents</Text><Text dimColor={true}> · /agents</Text></Box>{Array.from(groupBySource(agents).entries()).map(_temp22)}</Box>;
    $[56] = agents;
    $[57] = t11;
  } else {
    t11 = $[57];
  }
  let t12;
  if ($[58] !== memoryFiles) {
    t12 = memoryFiles.length > 0 && <Box flexDirection="column" marginTop={1}><Box><Text bold={true}>Memory files</Text><Text dimColor={true}> · /memory</Text></Box>{memoryFiles.map(_temp23)}</Box>;
    $[58] = memoryFiles;
    $[59] = t12;
  } else {
    t12 = $[59];
  }
  let t13;
  if ($[60] !== skills) {
    t13 = skills && skills.tokens > 0 && <Box flexDirection="column" marginTop={1}><Box><Text bold={true}>Skills</Text><Text dimColor={true}> · /skills</Text></Box>{Array.from(groupBySource(skills.skillFrontmatter).entries()).map(_temp25)}</Box>;
    $[60] = skills;
    $[61] = t13;
  } else {
    t13 = $[61];
  }
  let t14;
  if ($[62] !== messageBreakdown) {
    t14 = messageBreakdown && SHOW_INTERNAL_PANELS && <Box flexDirection="column" marginTop={1}><Text bold={true}>[internal] Message breakdown</Text><Box flexDirection="column" marginLeft={1}><Box><Text>Tool calls: </Text><Text dimColor={true}>{formatTokens(messageBreakdown.toolCallTokens)} tokens</Text></Box><Box><Text>Tool results: </Text><Text dimColor={true}>{formatTokens(messageBreakdown.toolResultTokens)} tokens</Text></Box><Box><Text>Attachments: </Text><Text dimColor={true}>{formatTokens(messageBreakdown.attachmentTokens)} tokens</Text></Box><Box><Text>Assistant messages (non-tool): </Text><Text dimColor={true}>{formatTokens(messageBreakdown.assistantMessageTokens)} tokens</Text></Box><Box><Text>User messages (non-tool-result): </Text><Text dimColor={true}>{formatTokens(messageBreakdown.userMessageTokens)} tokens</Text></Box></Box>{messageBreakdown.toolCallsByType.length > 0 && <Box flexDirection="column" marginTop={1}><Text bold={true}>[internal] Top tools</Text>{messageBreakdown.toolCallsByType.slice(0, 5).map(_temp26)}</Box>}{messageBreakdown.attachmentsByType.length > 0 && <Box flexDirection="column" marginTop={1}><Text bold={true}>[internal] Top attachments</Text>{messageBreakdown.attachmentsByType.slice(0, 5).map(_temp27)}</Box>}</Box>;
    $[62] = messageBreakdown;
    $[63] = t14;
  } else {
    t14 = $[63];
  }
  let t15;
  if ($[64] !== T0 || $[65] !== t10 || $[66] !== t11 || $[67] !== t12 || $[68] !== t13 || $[69] !== t14 || $[70] !== t2 || $[71] !== t3 || $[72] !== t4 || $[73] !== t5) {
    t15 = <T0 flexDirection={t2} marginLeft={t3}>{t4}{t5}{t10}{t11}{t12}{t13}{t14}</T0>;
    $[64] = T0;
    $[65] = t10;
    $[66] = t11;
    $[67] = t12;
    $[68] = t13;
    $[69] = t14;
    $[70] = t2;
    $[71] = t3;
    $[72] = t4;
    $[73] = t5;
    $[74] = t15;
  } else {
    t15 = $[74];
  }
  let t16;
  if ($[75] !== data) {
    t16 = generateContextSuggestions(data);
    $[75] = data;
    $[76] = t16;
  } else {
    t16 = $[76];
  }
  let t17;
  if ($[77] !== t16) {
    t17 = <ContextSuggestions suggestions={t16} />;
    $[77] = t16;
    $[78] = t17;
  } else {
    t17 = $[78];
  }
  let t18;
  if ($[79] !== T1 || $[80] !== t15 || $[81] !== t17 || $[82] !== t6 || $[83] !== t7 || $[84] !== t8 || $[85] !== t9) {
    t18 = <T1 flexDirection={t6} paddingLeft={t7}>{t8}{t9}{t15}{t17}</T1>;
    $[79] = T1;
    $[80] = t15;
    $[81] = t17;
    $[82] = t6;
    $[83] = t7;
    $[84] = t8;
    $[85] = t9;
    $[86] = t18;
  } else {
    t18 = $[86];
  }
  return t18;
}
function _temp27(
  attachment: AttachmentByType,
  i_10: number,
  arr: readonly unknown[],
) {
  return <Box key={i_10} marginLeft={1}><Text>{branchPrefix(i_10, arr)} {attachment.name}: </Text><Text dimColor={true}>{formatTokens(attachment.tokens)} tokens</Text></Box>;
}
function _temp26(tool_5: ToolCallByType, i_9: number, arr: readonly unknown[]) {
  return <Box key={i_9} marginLeft={1}><Text>{branchPrefix(i_9, arr)} {tool_5.name}: </Text><Text dimColor={true}>calls {formatTokens(tool_5.callTokens)}, results{" "}{formatTokens(tool_5.resultTokens)}</Text></Box>;
}
function _temp25(t0: [string, SkillFrontmatterInfo[]]) {
  const [sourceDisplay_0, sourceSkills] = t0;
  return <Box key={sourceDisplay_0} flexDirection="column" marginTop={1}><Text dimColor={true}>{sourceDisplay_0}</Text>{sourceSkills.map(_temp24)}</Box>;
}
function _temp24(
  skill: SkillFrontmatterInfo,
  i_8: number,
  arr: readonly unknown[],
) {
  return <Box key={i_8}><Text>{branchPrefix(i_8, arr)} {skill.name}: </Text><Text dimColor={true}>{formatTokens(skill.tokens)} tokens</Text></Box>;
}
function _temp23(file: MemoryFileInfo, i_7: number, arr: readonly unknown[]) {
  return <Box key={i_7}><Text>{branchPrefix(i_7, arr)} {getDisplayPath(file.path)}: </Text><Text dimColor={true}>{formatTokens(file.tokens)} tokens</Text></Box>;
}
function _temp22(t0: [string, AgentInfo[]]) {
  const [sourceDisplay, sourceAgents] = t0;
  return <Box key={sourceDisplay} flexDirection="column" marginTop={1}><Text dimColor={true}>{sourceDisplay}</Text>{sourceAgents.map(_temp21)}</Box>;
}
function _temp21(agent: AgentInfo, i_6: number, arr: readonly unknown[]) {
  return <Box key={i_6}><Text>{branchPrefix(i_6, arr)} {agent.agentType}: </Text><Text dimColor={true}>{formatTokens(agent.tokens)} tokens</Text></Box>;
}
function _temp20(
  section: SystemPromptSectionInfo,
  i_5: number,
  arr: readonly unknown[],
) {
  return <Box key={i_5}><Text>{branchPrefix(i_5, arr)} {section.name}: </Text><Text dimColor={true}>{formatTokens(section.tokens)} tokens</Text></Box>;
}
function _temp19(
  tool_4: DeferredBuiltinToolInfo,
  i_4: number,
  arr: readonly unknown[],
) {
  return <Box key={i_4}><Text dimColor={true}>{branchPrefix(i_4, arr)} {tool_4.name}</Text></Box>;
}
function _temp18(t_4: DeferredBuiltinToolInfo) {
  return !t_4.isLoaded;
}
function _temp17(t_5: DeferredBuiltinToolInfo) {
  return !t_5.isLoaded;
}
function _temp16(
  tool_3: DeferredBuiltinToolInfo,
  i_3: number,
  arr: readonly unknown[],
) {
  return <Box key={`def-${i_3}`}><Text>{branchPrefix(i_3, arr)} {tool_3.name}: </Text><Text dimColor={true}>{formatTokens(tool_3.tokens)} tokens</Text></Box>;
}
function _temp15(t_3: DeferredBuiltinToolInfo) {
  return t_3.isLoaded;
}
function _temp14(tool_2: SystemToolInfo, i_2: number, arr: readonly unknown[]) {
  return <Box key={`sys-${i_2}`}><Text>{branchPrefix(i_2, arr)} {tool_2.name}: </Text><Text dimColor={true}>{formatTokens(tool_2.tokens)} tokens</Text></Box>;
}
function _temp13(tool_1: McpToolInfo, i_1: number, arr: readonly unknown[]) {
  return <Box key={i_1}><Text>{branchPrefix(i_1, arr)} {tool_1.name}: </Text><Text dimColor={true}>{formatTokens(tool_1.tokens)} tokens</Text></Box>;
}
function _temp12(tool_0: McpToolInfo, i_0: number, arr: readonly unknown[]) {
  return <Box key={i_0}><Text dimColor={true}>{branchPrefix(i_0, arr)} {tool_0.name}</Text></Box>;
}
function _temp11(t_1: McpToolInfo) {
  return !t_1.isLoaded;
}
function _temp10(t_2: McpToolInfo) {
  return !t_2.isLoaded;
}
function _temp1(tool: McpToolInfo, i: number, arr: readonly unknown[]) {
  return <Box key={i}><Text>{branchPrefix(i, arr)} {tool.name}: </Text><Text dimColor={true}>{formatTokens(tool.tokens)} tokens</Text></Box>;
}
function _temp0(t: McpToolInfo) {
  return t.isLoaded;
}
function _temp9(t_0: McpToolInfo) {
  return t_0.isLoaded;
}
function _temp8(c_0: ContextCategory) {
  return c_0.name === "Free space";
}
function _temp7(c: ContextCategory) {
  return c.name === "Free space";
}
function _temp6(c_1: ContextCategory) {
  return c_1.name === "Free space";
}
function _temp5(row: GridSquare[], rowIndex: number) {
  return <Box key={rowIndex} flexDirection="row">{row.map(_temp4)}</Box>;
}
function _temp4(square: GridSquare, colIndex: number) {
  if (square.categoryName === "Free space") {
    return <Text key={colIndex} dimColor={true}>{"\u26F6 "}</Text>;
  }
  if (square.categoryName === RESERVED_CATEGORY_NAME) {
    return <Text key={colIndex} color={square.color}>{"\u26DD "}</Text>;
  }
  return <Text key={colIndex} color={square.color}>{square.squareFullness >= 0.7 ? "\u26C1 " : "\u26C0 "}</Text>;
}
function _temp3(cat_1: ContextCategory) {
  return cat_1.name === RESERVED_CATEGORY_NAME;
}
function _temp2(cat_0: ContextCategory) {
  return cat_0.isDeferred && cat_0.name.includes("MCP");
}
function _temp(cat: ContextCategory) {
  return cat.tokens > 0 && cat.name !== "Free space" && cat.name !== RESERVED_CATEGORY_NAME && !cat.isDeferred;
}
