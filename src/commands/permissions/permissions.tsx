import * as React from 'react';
import { PermissionRuleList } from 'src/permissions/ui/rules/PermissionRuleList.js';
import type { LocalJSXCommandCall } from 'src/shared/types/command.js';
import { createPermissionRetryMessage } from 'src/agent/messages/messages.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <PermissionRuleList onExit={onDone} onRetryDenials={commands => {
    context.setMessages(prev => [...prev, createPermissionRetryMessage(commands)]);
  }} />;
};
