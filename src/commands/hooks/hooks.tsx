import * as React from 'react';
import { HooksConfigMenu } from 'src/components/hooks/HooksConfigMenu.js';
import { logEvent } from 'src/services/analytics/index.js';
import { getTools } from 'src/tools.js';
import type { LocalJSXCommandCall } from 'src/types/command.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  logEvent('tengu_hooks_command', {});
  const appState = context.getAppState();
  const permissionContext = appState.toolPermissionContext;
  const toolNames = getTools(permissionContext).map(tool => tool.name);
  return <HooksConfigMenu toolNames={toolNames} onExit={onDone} />;
};
