import { feature } from 'bun:bundle';
import * as React from 'react';
import { useCallback } from 'react';
import { EnterPlanModeTool } from 'src/tools/EnterPlanModeTool/EnterPlanModeTool.js';
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js';
import { useNotifyAfterTimeout } from 'src/platform/notifications/useNotifyAfterTimeout.js';
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js';
import type { AnyObject, Tool, ToolUseContext } from 'src/tools/Tool.js';
import { AskUserQuestionTool } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { BashTool } from 'src/tools/BashTool/BashTool.js';
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js';
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js';
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js';
import { GitTool } from 'src/tools/GitTool/GitTool.js';
import { GlobTool } from 'src/tools/GlobTool/GlobTool.js';
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js';
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js';
import { PowerShellTool } from 'src/tools/PowerShellTool/PowerShellTool.js';
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js';
import { WebFetchTool } from 'src/tools/WebFetchTool/WebFetchTool.js';
import { WaitForTool } from 'src/tools/WaitForTool/WaitForTool.js';
import type { AssistantMessage } from 'src/shared/types/message.js';
import type { PermissionDecision } from 'src/permissions/PermissionResult.js';
import { AskUserQuestionPermissionRequest } from 'src/permissions/ui/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.js';
import { BashPermissionRequest } from 'src/permissions/ui/BashPermissionRequest/BashPermissionRequest.js';
import { EnterPlanModePermissionRequest } from 'src/permissions/ui/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.js';
import { ExitPlanModePermissionRequest } from 'src/permissions/ui/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js';
import { FallbackPermissionRequest } from 'src/permissions/ui/FallbackPermissionRequest.js';
import { FileEditPermissionRequest } from 'src/permissions/ui/FileEditPermissionRequest/FileEditPermissionRequest.js';
import { FilesystemPermissionRequest } from 'src/permissions/ui/FilesystemPermissionRequest/FilesystemPermissionRequest.js';
import { FileWritePermissionRequest } from 'src/permissions/ui/FileWritePermissionRequest/FileWritePermissionRequest.js';
import { GitPermissionRequest } from 'src/permissions/ui/GitPermissionRequest/GitPermissionRequest.js';
import { NotebookEditPermissionRequest } from 'src/permissions/ui/NotebookEditPermissionRequest/NotebookEditPermissionRequest.js';
import { PowerShellPermissionRequest } from 'src/permissions/ui/PowerShellPermissionRequest/PowerShellPermissionRequest.js';
import { SkillPermissionRequest } from 'src/permissions/ui/SkillPermissionRequest/SkillPermissionRequest.js';
import { WebFetchPermissionRequest } from 'src/permissions/ui/WebFetchPermissionRequest/WebFetchPermissionRequest.js';
import { MonitorPermissionRequest } from 'src/permissions/ui/MonitorPermissionRequest/MonitorPermissionRequest.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import type { z } from 'zod/v4';
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js';
import type { WorkerBadgeProps } from 'src/permissions/ui/WorkerBadge.js';

export type PermissionRequestProps<Input extends AnyObject = AnyObject> = {
  toolUseConfirm: ToolUseConfirm<Input>;
  toolUseContext: ToolUseContext;
  onDone(): void;
  onReject(): void;
  verbose: boolean;
  workerBadge: WorkerBadgeProps | undefined;
  setStickyFooter?: (jsx: React.ReactNode | null) => void;
};
export type ToolUseConfirm<Input extends AnyObject = AnyObject> = {
  assistantMessage: AssistantMessage;
  tool: Tool<Input>;
  description: string;
  input: z.infer<Input>;
  toolUseContext: ToolUseContext;
  toolUseID: string;
  permissionResult: PermissionDecision;
  permissionPromptStartTimeMs: number;
  classifierCheckInProgress?: boolean;
  classifierAutoApproved?: boolean;
  classifierMatchedRule?: string;
  workerBadge?: WorkerBadgeProps;
  onUserInteraction(): void;
  onAbort(): void;
  onDismissCheckmark?(): void;
  onAllow(updatedInput: z.infer<Input>, permissionUpdates: PermissionUpdate[], feedback?: string, contentBlocks?: ContentBlockParam[]): void;
  onReject(feedback?: string, contentBlocks?: ContentBlockParam[]): void;
  recheckPermission(): Promise<void>;
};
type PermissionDialogComponent = React.ComponentType<PermissionRequestProps>;

let dialogByTool: ReadonlyMap<unknown, PermissionDialogComponent> | undefined;

/**
 * Which dialog each tool's request is shown in, keyed by the tool object.
 * Built on first use, after every tool module has finished loading.
 */
function dialogRoutes(): ReadonlyMap<unknown, PermissionDialogComponent> {
  if (dialogByTool) return dialogByTool;
  const routes: Array<[unknown, PermissionDialogComponent]> = [
    [FileEditTool, FileEditPermissionRequest],
    [FileWriteTool, FileWritePermissionRequest],
    [BashTool, BashPermissionRequest],
    [PowerShellTool, PowerShellPermissionRequest],
    // Git is checked against Bash(...) rules; the tool-wide dialog's "don't ask again" would bypass them.
    [GitTool, GitPermissionRequest],
    [WebFetchTool, WebFetchPermissionRequest],
    [NotebookEditTool, NotebookEditPermissionRequest],
    [ExitPlanModeV2Tool, ExitPlanModePermissionRequest],
    [EnterPlanModeTool, EnterPlanModePermissionRequest],
    [SkillTool, SkillPermissionRequest],
    [AskUserQuestionTool, AskUserQuestionPermissionRequest],
    // Wait runs a shell command under the Bash rules, like Monitor, and that dialog names itself after its tool.
    [WaitForTool, MonitorPermissionRequest],
    [GlobTool, FilesystemPermissionRequest],
    [GrepTool, FilesystemPermissionRequest],
    [FileReadTool, FilesystemPermissionRequest],
  ];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const monitorTool = feature('MONITOR_TOOL') ? (require('src/tools/MonitorTool/MonitorTool.js') as typeof import('src/tools/MonitorTool/MonitorTool.js')).MonitorTool : null;
  if (monitorTool) routes.push([monitorTool, MonitorPermissionRequest]);
  dialogByTool = new Map(routes);
  return dialogByTool;
}

function permissionComponentForTool(tool: Tool): React.ComponentType<PermissionRequestProps> {
  return dialogRoutes().get(tool) ?? FallbackPermissionRequest;
}

// The named-tool wording says Claude where the others say Claudin; user hooks may match on it, so it stays.
function getNotificationMessage(toolUseConfirm: ToolUseConfirm): string {
  const { tool, input } = toolUseConfirm;
  if (tool === ExitPlanModeV2Tool) return 'Claudin needs your approval for the plan';
  if (tool === EnterPlanModeTool) return 'Claudin wants to enter plan mode';
  const name = tool.userFacingName(input);
  if (!name.trim()) return 'Claudin needs your attention';
  return `Claude needs your permission to use ${name}`;
}

/**
 * Shows a permission request in the dialog made for its tool. Ctrl+C
 * answers it as a deny, and an unanswered request leaves a notification.
 */
export function PermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm, onDone, onReject } = props;
  const interrupt = useCallback(() => {
    onDone();
    onReject();
    toolUseConfirm.onReject();
  }, [onDone, onReject, toolUseConfirm]);
  useKeybinding('app:interrupt', interrupt, { context: 'Confirmation' });
  useNotifyAfterTimeout(getNotificationMessage(toolUseConfirm), 'permission_prompt');
  const Dialog = permissionComponentForTool(toolUseConfirm.tool);
  return <Dialog {...props} />;
}
