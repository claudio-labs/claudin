import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { type ExitState } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import { Text } from 'src/ink.js';
import { extractMcpToolDisplayName, getMcpDisplayName } from 'src/services/mcp/mcpStringUtils.js';
import { filterToolsByServer } from 'src/services/mcp/utils.js';
import type { AppState } from 'src/state/AppState.js';
import { useAppState } from 'src/state/AppState.js';
import type { Tool } from 'src/Tool.js';
import { plural } from 'src/shared/text/stringUtils.js';
import { ConfigurableShortcutHint } from 'src/components/ConfigurableShortcutHint.js';
import { Select } from 'src/components/CustomSelect/index.js';
import { Byline } from 'src/components/design-system/Byline.js';
import { Dialog } from 'src/components/design-system/Dialog.js';
import { KeyboardShortcutHint } from 'src/components/design-system/KeyboardShortcutHint.js';
import type { ServerInfo } from 'src/components/mcp/types.js';
type Props = {
  server: ServerInfo;
  onSelectTool: (tool: Tool, index: number) => void;
  onBack: () => void;
};
export function MCPToolListView(t0: Props) {
  const $ = _c(21);
  const {
    server,
    onSelectTool,
    onBack
  } = t0;
  const mcpTools = useAppState(_temp);
  let t1: Tool[];
  bb0: {
    if (server.client.type !== "connected") {
      let t2: Tool[];
      if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
        t2 = [];
        $[0] = t2;
      } else {
        t2 = $[0];
      }
      t1 = t2;
      break bb0;
    }
    let t2: Tool[];
    if ($[1] !== mcpTools || $[2] !== server.name) {
      t2 = filterToolsByServer(mcpTools, server.name);
      $[1] = mcpTools;
      $[2] = server.name;
      $[3] = t2;
    } else {
      t2 = $[3];
    }
    t1 = t2;
  }
  const serverTools = t1;
  let t2;
  if ($[4] !== server.name || $[5] !== serverTools) {
    let t3: (tool: Tool, index: number) => {
      label: string;
      value: string;
      description: string | undefined;
      descriptionColor: string | undefined;
    };
    if ($[7] !== server.name) {
      t3 = (tool: Tool, index: number) => {
        const toolName = getMcpDisplayName(tool.name, server.name);
        const fullDisplayName = tool.userFacingName ? tool.userFacingName({}) : toolName;
        const displayName = extractMcpToolDisplayName(fullDisplayName);
        const isReadOnly = tool.isReadOnly?.({}) ?? false;
        const isDestructive = tool.isDestructive?.({}) ?? false;
        const isOpenWorld = tool.isOpenWorld?.({}) ?? false;
        const annotations = [];
        if (isReadOnly) {
          annotations.push("read-only");
        }
        if (isDestructive) {
          annotations.push("destructive");
        }
        if (isOpenWorld) {
          annotations.push("open-world");
        }
        return {
          label: displayName,
          value: index.toString(),
          description: annotations.length > 0 ? annotations.join(", ") : undefined,
          descriptionColor: isDestructive ? "error" : isReadOnly ? "success" : undefined
        };
      };
      $[7] = server.name;
      $[8] = t3;
    } else {
      t3 = $[8];
    }
    t2 = serverTools.map(t3);
    $[4] = server.name;
    $[5] = serverTools;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  const toolOptions = t2;
  const t3 = `Tools for ${server.name}`;
  const t4 = serverTools.length;
  let t5;
  if ($[9] !== serverTools.length) {
    t5 = plural(serverTools.length, "tool");
    $[9] = serverTools.length;
    $[10] = t5;
  } else {
    t5 = $[10];
  }
  const t6 = `${t4} ${t5}`;
  let t7;
  if ($[11] !== onBack || $[12] !== onSelectTool || $[13] !== serverTools || $[14] !== toolOptions) {
    t7 = serverTools.length === 0 ? <Text dimColor={true}>No tools available</Text> : <Select options={toolOptions} onChange={value => {
      const index_0 = parseInt(value);
      const tool_0 = serverTools[index_0];
      if (tool_0) {
        onSelectTool(tool_0, index_0);
      }
    }} onCancel={onBack} />;
    $[11] = onBack;
    $[12] = onSelectTool;
    $[13] = serverTools;
    $[14] = toolOptions;
    $[15] = t7;
  } else {
    t7 = $[15];
  }
  let t8;
  if ($[16] !== onBack || $[17] !== t3 || $[18] !== t6 || $[19] !== t7) {
    t8 = <Dialog title={t3} subtitle={t6} onCancel={onBack} inputGuide={_temp2}>{t7}</Dialog>;
    $[16] = onBack;
    $[17] = t3;
    $[18] = t6;
    $[19] = t7;
    $[20] = t8;
  } else {
    t8 = $[20];
  }
  return t8;
}
function _temp2(exitState: ExitState) {
  return exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" /></Byline>;
}
function _temp(s: AppState) {
  return s.mcp.tools;
}
