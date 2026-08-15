import * as React from 'react';
import type { LocalJSXCommandContext } from 'src/commands/commands.js';
import { SkillsMenu } from 'src/skills/ui/SkillsMenu.js';
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <SkillsMenu onExit={onDone} commands={context.options.commands} />;
}
