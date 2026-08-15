import * as React from 'react';
import type { LocalJSXCommandContext } from 'src/commands.js';
import { BackgroundTasksDialog } from 'src/agent/ui/tasks/BackgroundTasksDialog.js';
import type { LocalJSXCommandOnDone } from 'src/types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <BackgroundTasksDialog toolUseContext={context} onDone={onDone} />;
}
