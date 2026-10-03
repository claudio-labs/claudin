import React from 'react';
import type { ThinkingConfig } from 'src/agent/context/thinking.js';
import type { Command } from 'src/commands/commands.js';
import type { MCPServerConnection, ScopedMcpServerConfig } from 'src/mcp/types.js';
import { ResumePicker } from 'src/sessions/ui/resumePicker/ResumePicker.js';
import type { Message } from 'src/shared/types/message.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import type { Tool } from 'src/tools/Tool.js';
type Props = {
  commands: Command[];
  worktreePaths: string[];
  initialTools: Tool[];
  mcpClients?: MCPServerConnection[];
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>;
  debug: boolean;
  mainThreadAgentDefinition?: AgentDefinition;
  autoConnectIdeFlag?: boolean;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  initialSearchQuery?: string;
  disableSlashCommands?: boolean;
  forkSession?: boolean;
  taskListId?: string;
  filterByPr?: boolean | number | string;
  thinkingConfig: ThinkingConfig;
  onTurnComplete?: (messages: Message[]) => void | Promise<void>;
};
export type { Props as ResumeConversationProps };

function endProcess(code: number): void {
  process.exit(code);
}

/** `claudin --resume` without a session id: pick a session, then the REPL opens on it. */
export function ResumeConversation(props: Props): React.ReactNode {
  return <ResumePicker {...props} exit={endProcess} />;
}
