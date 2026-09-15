import * as React from 'react';
import { HooksConfigMenu } from 'src/platform/lifecycleHooks/ui/HooksConfigMenu.js';
import { getTools } from 'src/tools/tools.js';
import type { LocalJSXCommandCall } from 'src/shared/types/command.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  const appState = context.getAppState();
  const permissionContext = appState.toolPermissionContext;
  const toolNames = getTools(permissionContext).map(tool => tool.name);
  return <HooksConfigMenu toolNames={toolNames} onExit={onDone} />;
};
