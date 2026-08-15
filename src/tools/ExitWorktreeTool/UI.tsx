import * as React from 'react';
import { Box, Text } from 'src/terminal/ink.js';
import type { ToolProgressData } from 'src/tools/Tool.js';
import type { ProgressMessage } from 'src/shared/types/message.js';
import type { ThemeName } from 'src/terminal/theme/theme.js';
import type { Output } from 'src/tools/ExitWorktreeTool/ExitWorktreeTool.js';
export function renderToolUseMessage(): React.ReactNode {
  return 'Exiting worktree…';
}
export function renderToolResultMessage(output: Output, _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], _options: {
  theme: ThemeName;
}): React.ReactNode {
  const actionLabel = output.action === 'keep' ? 'Kept worktree' : 'Removed worktree';
  return <Box flexDirection="column">
      <Text>
        {actionLabel}
        {output.worktreeBranch ? <>
            {' '}
            (branch <Text bold>{output.worktreeBranch}</Text>)
          </> : null}
      </Text>
      <Text dimColor>Returned to {output.originalCwd}</Text>
    </Box>;
}
