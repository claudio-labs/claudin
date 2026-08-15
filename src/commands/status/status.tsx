import * as React from 'react';
import type { LocalJSXCommandContext } from 'src/commands/commands.js';
import { Settings } from 'src/platform/settings/ui/Settings.js';
import type { LocalJSXCommandOnDone } from 'src/types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <Settings onClose={onDone} context={context} defaultTab="Status" />;
}
